import type { Document } from '../document.js';
import type { Component, GObject, Property } from '../properties/index.js';
import { buildProjectReferenceGraph, type ProjectReferenceEdge } from '../references/project-reference-graph.js';
import {
	DocumentEditError,
	readAuthoringProperties,
	setAuthoringProperties,
	type AuthoringTarget,
} from './document-edit.js';

export interface AuthoringBindings {
	nodes?: Record<string, string>;
	controllers?: Record<string, string>;
	pages?: Record<string, string>;
}

export function retainRelativeResources(node: GObject, packageId: string): void {
	const props = readAuthoringProperties(node);
	if (typeof props.src === 'string' && props.src && !props.src.startsWith('ui://') && !props.packageId)
		setAuthoringProperties(node, { packageId });
}

export function mapNodeScope(
	node: GObject,
	oldId: string,
	destination: Component,
	bindings: AuthoringBindings = {},
): void {
	const mapNode = (id: string): string => {
		if (!id) return id;
		if (id === oldId) return node.getId();
		const mapped = bindings.nodes?.[id];
		if (mapped === undefined || (mapped && !destination.getChildById(mapped)))
			throw new DocumentEditError('UNSAFE_REFERENCE', '跨组件节点引用需要有效的显式映射', 'bindings.nodes', {
				id,
			});
		return mapped;
	};
	const mapController = (name: string) => {
		const mapped = bindings.controllers?.[name];
		const controller = mapped === undefined ? undefined : destination.getController(mapped);
		if (!controller)
			throw new DocumentEditError('UNSAFE_REFERENCE', '跨组件控制器引用需要显式映射', 'bindings.controllers', {
				name,
			});
		return controller;
	};
	const mapPage = (controller: string, page: string): string => {
		if (!page) return page;
		const mapped = bindings.pages?.[`${controller}/${page}`];
		if (
			mapped === undefined ||
			!mapController(controller)
				.listPages()
				.some((p) => p.getId() === mapped)
		)
			throw new DocumentEditError('UNSAFE_REFERENCE', '跨组件页面引用需要显式映射', 'bindings.pages', {
				controller,
				page,
			});
		return mapped;
	};
	node.setRelations(node.getRelations().map((r) => ({ ...r, target: mapNode(r.target) })));
	const props = readAuthoringProperties(node);
	if (props.group) setAuthoringProperties(node, { group: mapNode(String(props.group)) });
	if (props.instanceController) {
		const name = String(props.instanceController);
		setAuthoringProperties(node, {
			instanceController: mapController(name).getName(),
			instancePage: mapPage(name, String(props.instancePage ?? '')),
		});
	}
	for (const gear of node.listGears()) {
		const controller = gear.getController();
		if (!controller) continue;
		const name = controller.getName();
		gear.setController(mapController(name));
		gear.setPages(
			gear
				.getPages()
				.split(',')
				.map((p) => mapPage(name, p))
				.join(','),
		);
		gear.setPageValues(
			Object.fromEntries(Object.entries(gear.getPageValues()).map(([p, v]) => [mapPage(name, p), v])),
		);
	}
}

function edgeOwner(document: Document, edge: ProjectReferenceEdge): Property {
	const source = edge.source;
	const component = document
		.getRoot()
		.getPackageById(source.packageId)!
		.listComponents()
		.find((c) => c.getId() === source.componentId)!;
	const node = source.nodeId ? component.getChildById(source.nodeId)! : component;
	if (source.gearIndex !== undefined) return (node as GObject).listGears()[source.gearIndex]!;
	if (source.itemIndex !== undefined)
		return component.getTransition(source.transition!)!.listItems()[source.itemIndex]!;
	if (source.actionIndex !== undefined)
		return component.getController(source.controller!)!.listActions()[source.actionIndex]!;
	return node;
}

/**
 * Rewrites only graph-indexed fields; user text and opaque payloads are not searched.
 */
export function rewriteResourceReferences(
	document: Document,
	edges: ProjectReferenceEdge[],
	from: { packageId: string; id: string },
	to: { packageId: string; id: string },
): void {
	const oldURL = `ui://${from.packageId}${from.id}`;
	const newURL = `ui://${to.packageId}${to.id}`;
	for (const edge of edges) {
		if (edge.cascade === 'unsupported')
			throw new DocumentEditError('UNSAFE_REFERENCE', '资源引用无法安全迁移', edge.field, edge);
		const owner = edgeOwner(document, edge);
		if (edge.field === 'src') {
			setAuthoringProperties(owner, { src: to.id, packageId: to.packageId });
			continue;
		}
		const segments = edge.field.replace(/\[(\d+)\]/g, '.$1').split('.');
		const key = segments.shift()!;
		const props = readAuthoringProperties(owner);
		let value = structuredClone(props[key]);
		const replace = (input: unknown): unknown => {
			if (typeof input === 'string')
				return input.replace(/ui:\/\/[a-zA-Z0-9]{8}[a-zA-Z0-9_./-]+/g, (url) =>
					url === oldURL ? newURL : url,
				);
			if (Array.isArray(input)) return input.map(replace);
			if (input && typeof input === 'object')
				return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, replace(v)]));
			return input;
		};
		if (!segments.length) value = replace(value);
		else {
			let parent = value as Record<string, unknown>;
			for (const part of segments.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
			const last = segments.at(-1)!;
			parent[last] = replace(parent[last]);
		}
		setAuthoringProperties(owner, { [key]: value });
	}
}

/**
 * Resolves reference-valued properties after allocation so new objects can refer forward.
 */
export function resolveBatchProperties(document: Document, refs: Record<string, AuthoringTarget>): void {
	const graph = buildProjectReferenceGraph(document);
	for (const edge of graph.edges) {
		if (!edge.target.id.startsWith('@')) continue;
		const ref = refs[edge.target.id.slice(1)];
		const id =
			edge.target.kind === 'node'
				? ref?.nodeId
				: edge.target.kind === 'page'
					? ref?.pageId
					: edge.target.kind === 'resource'
						? (ref?.resourceId ?? ref?.componentId)
						: edge.target.kind === 'controller'
							? ref?.controllerName
							: ref?.transitionName;
		if (!id)
			throw new DocumentEditError(
				'INVALID_CLIENT_REF',
				'引用字段的批次引用不存在或类型不匹配',
				edge.field,
				edge.target,
			);
		if (
			edge.target.kind !== 'resource' &&
			(ref!.packageId !== edge.source.packageId || ref!.componentId !== edge.source.componentId)
		)
			throw new DocumentEditError('UNSAFE_REFERENCE', '局部批次引用跨越组件作用域', edge.field);
		const owner = edgeOwner(document, edge);
		const keys = edge.field.replace(/\[(\d+)\]/g, '.$1').split('.');
		const key = keys.shift()!;
		const props = readAuthoringProperties(owner);
		if (key === 'src') {
			setAuthoringProperties(owner, { src: id, packageId: ref!.packageId });
			continue;
		}
		let value = structuredClone(props[key]);
		if (!keys.length)
			value = String(value)
				.split(',')
				.map((v) => (v === edge.target.id ? id : v))
				.join(',');
		else {
			let parent = value as Record<string, unknown>;
			for (const part of keys.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
			parent[keys.at(-1)!] = id;
		}
		setAuthoringProperties(owner, { [key]: value });
	}
}
