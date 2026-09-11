import { Document } from '../document.js';
import { GearType, PropertyType } from '../constants.js';
import type { Component, Controller, Gear, GObject, Package, Property, Transition } from '../properties/index.js';
import type { ProjectFileTarget } from '../io/project-files.js';
import {
	buildProjectReferenceGraph,
	compareProjectDiagnostics,
	type ProjectReferenceEdge,
	type ProjectReferenceTarget,
} from '../references/project-reference-graph.js';
import { generateChildId, generatePackageId, generateResourceId } from '../utils/id-utils.js';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { assertAuthoringOperations } from './schema.js';

export interface AuthoringTarget {
	kind:
		| 'project'
		| 'package'
		| 'resource'
		| 'component'
		| 'node'
		| 'controller'
		| 'page'
		| 'gear'
		| 'transition'
		| 'transition-item'
		| 'controller-action';
	packageId?: string;
	componentId?: string;
	resourceId?: string;
	nodeId?: string;
	controllerName?: string;
	pageId?: string;
	transitionName?: string;
	index?: number;
	selector?: string;
	expectedMatches?: number;
}

export type AuthoringScope = 'base' | { controller: string; pageId: string } | { controller: string; allPages: true };

export interface DocumentEditOperation {
	op: 'create' | 'update' | 'remove' | 'move' | 'replace' | 'clone';
	target: AuthoringTarget;
	props?: Record<string, unknown>;
	type?: string;
	clientRef?: string;
	scope?: AuthoringScope;
	cascade?: boolean;
	toIndex?: number;
	destination?: AuthoringTarget;
}

export interface DocumentEditResult {
	document: Document;
	affected: ProjectFileTarget[];
	clientRefs: Record<string, AuthoringTarget>;
	operationResults: Array<{ index: number; op: string; targets: AuthoringTarget[] }>;
	diagnostics: ReturnType<typeof compareProjectDiagnostics>;
}

export class DocumentEditError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly path?: string,
		public readonly details?: unknown,
	) {
		super(message);
		this.name = 'DocumentEditError';
	}
}

type Mutable = Property & Record<string, unknown>;
const forbiddenProperties = new Set([
	'id',
	'projectId',
	'propertyType',
	'extras',
	'sourceData',
	'sourceWidth',
	'sourceHeight',
	'initWidth',
	'initHeight',
	'buffer',
	'graph',
	'extension',
	'controller',
]);
const pairSetters: Record<string, [string, string, string]> = {
	width: ['setSize', 'width', 'height'],
	height: ['setSize', 'width', 'height'],
	pivotX: ['setPivot', 'pivotX', 'pivotY'],
	pivotY: ['setPivot', 'pivotX', 'pivotY'],
	scaleX: ['setScale', 'scaleX', 'scaleY'],
	scaleY: ['setScale', 'scaleX', 'scaleY'],
	skewX: ['setSkew', 'skewX', 'skewY'],
	skewY: ['setSkew', 'skewX', 'skewY'],
};
const suffix = (key: string) => key[0]!.toUpperCase() + key.slice(1);
const asMutable = (value: Property) => value as Mutable;

function invoke(owner: Property, method: string, ...args: unknown[]): unknown {
	const fn = asMutable(owner)[method];
	if (typeof fn !== 'function') throw new DocumentEditError('INVALID_PROPERTY', `对象不提供 ${method}`);
	return fn.apply(owner, args);
}

/**
 * Copies every reachable property into a separate document, retaining opaque data.
 */
export function cloneDocument(source: Document): Document {
	const target = new Document().setProjectDir(source.getProjectDir());
	const copies = new Map<Property, Property>([[source.getRoot(), target.getRoot()]]);
	const resolve = <T extends Property>(property: T): T => {
		const existing = copies.get(property);
		if (existing) return existing as T;
		const Constructor = property.constructor as new (graph: ReturnType<Document['getGraph']>) => T;
		const copy = new Constructor(target.getGraph());
		copies.set(property, copy);
		copy.copy(property, resolve);
		return copy;
	};
	target.getRoot().copy(source.getRoot(), resolve);
	target.getRoot().setSettings(structuredClone(source.getRoot().getSettings()));
	target.getRoot().setExtras(structuredClone(source.getRoot().getExtras()));
	for (const pkg of source.getRoot().listPackages()) resolve(pkg);
	return target;
}

/**
 * Returns scalar and structured editable properties using native property names.
 */
export function readAuthoringProperties(owner: Property): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (
		let prototype = Object.getPrototypeOf(owner);
		prototype && prototype !== Object.prototype;
		prototype = Object.getPrototypeOf(prototype)
	) {
		for (const method of Object.getOwnPropertyNames(prototype)) {
			if (!/^get[A-Z]/.test(method)) continue;
			const key = method[3]!.toLowerCase() + method.slice(4);
			if (forbiddenProperties.has(key) || Object.hasOwn(result, key)) continue;
			const getter = asMutable(owner)[method];
			const setter = asMutable(owner)[`set${suffix(key)}`];
			if (typeof getter !== 'function' || getter.length || (typeof setter !== 'function' && !pairSetters[key]))
				continue;
			const value = getter.call(owner);
			if (value instanceof Object && 'propertyType' in value) continue;
			try {
				result[key] = value === undefined ? null : JSON.parse(JSON.stringify(value));
			} catch {
				/* Graph-backed values use explicit target operations. */
			}
		}
	}
	return result;
}

function validJson(value: unknown): boolean {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(validJson);
	return (
		typeof value === 'object' &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype &&
		Object.entries(value).every(
			([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && validJson(item),
		)
	);
}

function mergeValue(old: unknown, patch: unknown): unknown {
	if (patch && !Array.isArray(patch) && typeof patch === 'object') {
		const value: Record<string, unknown> =
			old && typeof old === 'object' && !Array.isArray(old)
				? structuredClone(old as Record<string, unknown>)
				: {};
		for (const [key, child] of Object.entries(patch)) {
			if (child === null) delete value[key];
			else value[key] = mergeValue(value[key], child);
		}
		return value;
	}
	return structuredClone(patch);
}

export function setAuthoringProperties(owner: Property, props: Record<string, unknown>): void {
	const current = readAuthoringProperties(owner);
	const Constructor = owner.constructor as new (graph: ReturnType<Document['getGraph']>) => Property;
	const defaults = readAuthoringProperties(new Constructor(new Document().getGraph()));
	for (const [key, raw] of Object.entries(props)) {
		if (!Object.hasOwn(current, key) || forbiddenProperties.has(key) || !validJson(raw))
			throw new DocumentEditError('INVALID_PROPERTY', `属性不可写或值不合法：${key}`, `props.${key}`);
		if (raw === null && ['name', 'text', 'settings'].includes(key))
			throw new DocumentEditError('INVALID_PROPERTY', `属性不能清除：${key}`, `props.${key}`);
		const value = raw === null ? defaults[key] : mergeValue(current[key], raw);
		const expected = defaults[key];
		if (
			expected !== null &&
			expected !== undefined &&
			(Array.isArray(expected) ? !Array.isArray(value) : typeof expected !== typeof value)
		)
			throw new DocumentEditError('INVALID_PROPERTY', `属性类型不匹配：${key}`, `props.${key}`);
		if (
			typeof value === 'number' &&
			(!Number.isFinite(value) ||
				(/^(width|height|minWidth|minHeight|maxWidth|maxHeight|fontSize)$/.test(key) && value < 0) ||
				(key === 'alpha' && (value < 0 || value > 1)))
		)
			throw new DocumentEditError('INVALID_PROPERTY', `属性超出范围：${key}`, `props.${key}`);
		if (
			key === 'relations' &&
			(!Array.isArray(value) ||
				value.some(
					(r) =>
						!r ||
						typeof r.target !== 'string' ||
						!Number.isInteger(r.type) ||
						r.type < 0 ||
						r.type > 24 ||
						typeof r.usePercent !== 'boolean',
				))
		)
			throw new DocumentEditError('INVALID_PROPERTY', 'Relations 格式无效', 'props.relations');
		current[key] = value;
	}
	for (const key of Object.keys(props)) {
		const pair = pairSetters[key];
		const setter = `set${suffix(key)}`;
		if (typeof asMutable(owner)[setter] === 'function') invoke(owner, setter, current[key]);
		else if (pair) invoke(owner, pair[0], current[pair[1]], current[pair[2]], current.pivotAsAnchor ?? false);
	}
}

export function resolveAuthoringTarget(document: Document, target: AuthoringTarget): Property[] {
	const root = document.getRoot();
	if (target.kind === 'project') return [root];
	const pkg = root.getPackageById(target.packageId ?? '');
	if (!pkg) throw new DocumentEditError('PACKAGE_NOT_FOUND', `包不存在：${target.packageId}`);
	if (target.kind === 'package') return [pkg];
	if (target.kind === 'resource') {
		const resource = pkg.getResourceById(target.resourceId ?? '');
		if (!resource) throw new DocumentEditError('RESOURCE_NOT_FOUND', `资源不存在：${target.resourceId}`);
		return [resource];
	}
	const component = pkg.listComponents().find((c) => c.getId() === target.componentId);
	if (!component) throw new DocumentEditError('COMPONENT_NOT_FOUND', `组件不存在：${target.componentId}`);
	if (target.kind === 'component') return [component];
	const node = component.getChildById(target.nodeId ?? '');
	const controller = component.getController(target.controllerName ?? '');
	const transition = component.getTransition(target.transitionName ?? '');
	let values: Property[] = [];
	switch (target.kind) {
		case 'node': {
			if (target.nodeId) values = node ? [node] : [];
			else if (target.selector) {
				const selector = target.selector;
				const id = /^#([\w-]+)$/.exec(selector);
				const name = /^(?:([\w-]+))?\[name=["']([^"']*)["']\]$/.exec(selector);
				const type = /^[A-Za-z][\w-]*$/.test(selector) ? selector : undefined;
				if (!id && !name && !type) throw new DocumentEditError('INVALID_SELECTOR', `选择器无效：${selector}`);
				values = component
					.listChildren()
					.filter((c) =>
						id
							? c.getId() === id[1]
							: name
								? c.getName() === name[2] && (!name[1] || c.propertyType === name[1])
								: c.propertyType === type,
					);
			}
			break;
		}
		case 'controller':
			values = controller ? [controller] : [];
			break;
		case 'page':
			values = controller?.listPages().filter((p) => p.getId() === target.pageId) ?? [];
			break;
		case 'gear':
			values = node && target.index !== undefined ? node.listGears().slice(target.index, target.index + 1) : [];
			break;
		case 'transition':
			values = transition ? [transition] : [];
			break;
		case 'transition-item':
			values =
				transition && target.index !== undefined
					? transition.listItems().slice(target.index, target.index + 1)
					: [];
			break;
		case 'controller-action':
			values =
				controller && target.index !== undefined
					? controller.listActions().slice(target.index, target.index + 1)
					: [];
			break;
	}
	const expected = target.expectedMatches ?? 1;
	if (!Number.isSafeInteger(expected) || expected < 1 || values.length !== expected)
		throw new DocumentEditError('SELECTOR_MATCH_COUNT', '匹配数量与预期不一致', 'target', {
			expected,
			actual: values.length,
		});
	return values;
}

const gearFields: Record<number, string[]> = {
	[GearType.Display]: ['visible'],
	[GearType.Display2]: ['visible'],
	[GearType.XY]: ['x', 'y'],
	[GearType.Size]: ['width', 'height', 'scaleX', 'scaleY'],
	[GearType.Look]: ['alpha', 'rotation', 'grayed', 'touchable'],
	[GearType.Color]: ['color', 'outlineColor'],
	[GearType.Animation]: ['playing', 'frame'],
	[GearType.Text]: ['text'],
	[GearType.Icon]: ['icon'],
	[GearType.FontSize]: ['fontSize'],
};

function updateNode(node: GObject, props: Record<string, unknown>, scope?: AuthoringScope): void {
	const bindings = node
		.listGears()
		.filter((g) => (gearFields[g.getGearType()] ?? []).some((key) => Object.hasOwn(props, key)));
	if (bindings.length && scope === undefined)
		throw new DocumentEditError('GEAR_SCOPE_REQUIRED', '受控属性需要明确基础值或控制器页面范围', 'scope');
	if (!scope || scope === 'base') {
		setAuthoringProperties(node, props);
		return;
	}
	const current = readAuthoringProperties(node);
	for (const [key, value] of Object.entries(props)) {
		const gear = bindings.find(
			(g) => g.getController()?.getName() === scope.controller && gearFields[g.getGearType()]?.includes(key),
		);
		if (!gear) throw new DocumentEditError('GEAR_NOT_FOUND', `属性 ${key} 未绑定到控制器 ${scope.controller}`);
		const controller = gear.getController()!;
		const selected = 'allPages' in scope ? controller.listPages().map((p) => p.getId()) : [scope.pageId];
		if (selected.some((id) => !controller.listPages().some((p) => p.getId() === id)))
			throw new DocumentEditError('PAGE_NOT_FOUND', '控制器页面不存在');
		const fields = gearFields[gear.getGearType()]!;
		if (key === 'visible') {
			if (typeof value !== 'boolean') throw new DocumentEditError('INVALID_PROPERTY', 'visible 必须是布尔值');
			const pages = new Set(gear.getPages().split(',').filter(Boolean));
			for (const id of selected) value ? pages.add(id) : pages.delete(id);
			gear.setPages([...pages].join(','));
			continue;
		}
		// Validate through a detached copy so scoped values do not alter base values.
		const probe = node.clone();
		try {
			setAuthoringProperties(probe, { [key]: value });
		} finally {
			probe.dispose();
		}
		const pages = gear.getPages().split(',').filter(Boolean);
		const values = gear.getValues().split('|');
		const byPage = { ...gear.getPageValues() };
		for (const id of selected) {
			let index = pages.indexOf(id);
			if (index < 0) {
				index = pages.length;
				pages.push(id);
			}
			const previous =
				values[index] ??
				String(byPage[id] ?? gear.getDefaultValue() ?? fields.map((f) => current[f] ?? 0).join(','));
			const tuple = fields.length === 1 ? [previous] : previous.split(',');
			tuple[fields.indexOf(key)] = String(value ?? current[key]);
			values[index] = tuple.join(',');
			byPage[id] = values[index];
		}
		gear.setPages(pages.join(',')).setValues(values.join('|')).setPageValues(byPage);
	}
}

function referenceTarget(target: AuthoringTarget): ProjectReferenceTarget | undefined {
	const packageId = target.packageId!;
	const componentId = target.componentId;
	switch (target.kind) {
		case 'package':
			return { kind: 'package', packageId, id: packageId };
		case 'component':
			return { kind: 'resource', packageId, id: componentId! };
		case 'resource':
			return { kind: 'resource', packageId, id: target.resourceId! };
		case 'node':
			return { kind: 'node', packageId, componentId, id: target.nodeId! };
		case 'controller':
			return { kind: 'controller', packageId, componentId, id: target.controllerName! };
		case 'page':
			return { kind: 'page', packageId, componentId, controller: target.controllerName, id: target.pageId! };
		case 'transition':
			return { kind: 'transition', packageId, componentId, id: target.transitionName! };
		default:
			return undefined;
	}
}

function clearReference(document: Document, edge: ProjectReferenceEdge): void {
	const source = edge.source;
	const component = document
		.getRoot()
		.getPackageById(source.packageId)!
		.listComponents()
		.find((c) => c.getId() === source.componentId)!;
	const node = source.nodeId ? component.getChildById(source.nodeId) : null;
	if (edge.cascade === 'unsupported')
		throw new DocumentEditError('UNSAFE_REFERENCE', '引用无法安全级联清理', edge.field, edge);
	if (source.gearIndex !== undefined && node) {
		const gear = node.listGears()[source.gearIndex];
		if (gear) node.removeGear(gear);
		return;
	}
	if (source.itemIndex !== undefined && source.transition) {
		const transition = component.getTransition(source.transition)!;
		const item = transition.listItems()[source.itemIndex];
		if (item) transition.removeItem(item);
		return;
	}
	if (source.actionIndex !== undefined && source.controller) {
		const controller = component.getController(source.controller)!;
		const action = controller.listActions()[source.actionIndex];
		if (action) controller.removeAction(action);
		return;
	}
	const owner = node ?? component;
	if (edge.field.startsWith('relations[')) {
		const relations = invoke(owner, 'getRelations') as Array<{ target: string }>;
		invoke(
			owner,
			'setRelations',
			relations.filter((r) => r.target !== edge.target.id),
		);
	} else if (edge.field === 'mask') component.setMask('').setReversedMask(false);
	else if (edge.field === 'group') invoke(owner, 'setGroup', '');
	else if (edge.cascade === 'remove-owner' && node) component.removeChild(node);
	else if (/^listItems\[(\d+)\]\.(\w+)$/.test(edge.field)) {
		const match = /^listItems\[(\d+)\]\.(\w+)$/.exec(edge.field)!;
		const items = structuredClone(invoke(owner, 'getListItems')) as Record<string, unknown>[];
		items[Number(match[1])]![match[2]!] = null;
		invoke(owner, 'setListItems', items);
	} else invoke(owner, `set${suffix(edge.field)}`, '');
}

function locateOwner(document: Document, target: AuthoringTarget): { pkg?: Package; component?: Component } {
	const pkg = document.getRoot().getPackageById(target.packageId ?? '') ?? undefined;
	const component = pkg?.listComponents().find((c) => c.getId() === target.componentId);
	return { pkg, component };
}

function cloneProperty<T extends Property>(document: Document, source: T, retainControllers = false): T {
	const copies = new Map<Property, Property>();
	const resolve = <P extends Property>(property: P): P => {
		if (retainControllers && property.propertyType === PropertyType.CONTROLLER) return property;
		const old = copies.get(property);
		if (old) return old as P;
		const Constructor = property.constructor as new (graph: ReturnType<Document['getGraph']>) => P;
		const copy = new Constructor(document.getGraph());
		copies.set(property, copy);
		copy.copy(property, resolve);
		return copy;
	};
	return resolve(source);
}

function remapComponentNodes(component: Component): void {
	const ids = new Map(component.listChildren().map((child, index) => [child.getId(), `n${index}`]));
	for (const child of component.listChildren()) {
		child.setId(ids.get(child.getId())!);
		child.setRelations(child.getRelations().map((r) => ({ ...r, target: ids.get(r.target) ?? r.target })));
		const group = String(typeof asMutable(child).getGroup === 'function' ? invoke(child, 'getGroup') : '');
		if (group && ids.has(group)) invoke(child, 'setGroup', ids.get(group));
	}
	component.setMask(ids.get(component.getMask()) ?? component.getMask());
	component.setIdNum(component.listChildren().length);
	for (const controller of component.listControllers())
		for (const action of controller.listActions())
			action.setObjectId(ids.get(action.getObjectId()) ?? action.getObjectId());
	for (const transition of component.listTransitions())
		for (const item of transition.listItems()) item.setTargetId(ids.get(item.getTargetId()) ?? item.getTargetId());
	const xml = component.getExtras()._sourceComponentXml;
	if (typeof xml === 'string') {
		const options = {
			preserveOrder: true,
			ignoreAttributes: false,
			attributeNamePrefix: '',
			parseTagValue: false,
			parseAttributeValue: false,
		};
		const tree = new XMLParser(options).parse(xml) as Record<string, unknown>[];
		const walk = (entries: Record<string, unknown>[], parent = '') => {
			for (const entry of entries) {
				const tag = Object.keys(entry).find((k) => k !== ':@')!;
				const attrs = entry[':@'] as Record<string, string> | undefined;
				if (attrs) {
					const fields =
						parent === 'displayList'
							? ['id', 'group']
							: tag === 'relation'
								? ['target']
								: tag === 'component' && !parent
									? ['mask']
									: tag === 'item' && parent === 'transition'
										? ['target']
										: tag === 'action' && parent === 'controller'
											? ['objectId']
											: [];
					for (const field of fields) if (ids.has(attrs[field]!)) attrs[field] = ids.get(attrs[field]!)!;
				}
				if (Array.isArray(entry[tag])) walk(entry[tag] as Record<string, unknown>[], tag);
			}
		};
		walk(tree);
		component.setExtras({
			...component.getExtras(),
			_sourceComponentXml: new XMLBuilder({ ...options, format: true }).build(tree),
		});
	}
}

/**
 * Applies an edit batch to an isolated graph and returns its affected source scope.
 */
export function applyDocumentEdits(source: Document, operations: readonly DocumentEditOperation[]): DocumentEditResult {
	assertAuthoringOperations(operations);
	if (!operations.length || operations.length > 200)
		throw new DocumentEditError('INVALID_EDIT', '编辑批次必须包含 1 至 200 项操作');
	const document = cloneDocument(source);
	const before = buildProjectReferenceGraph(source).diagnostics;
	const clientRefs: Record<string, AuthoringTarget> = {};
	const affected = new Map<string, ProjectFileTarget>();
	const operationResults: DocumentEditResult['operationResults'] = [];
	const touch = (target: AuthoringTarget) => {
		const entry: ProjectFileTarget =
			target.kind === 'project'
				? { kind: 'project' }
				: ['package', 'resource'].includes(target.kind)
					? { kind: 'package', packageId: target.packageId! }
					: { kind: 'component', packageId: target.packageId!, componentId: target.componentId! };
		affected.set(JSON.stringify(entry), entry);
	};
	const resolve = (input: AuthoringTarget): AuthoringTarget => {
		const target = { ...input };
		for (const key of ['packageId', 'componentId', 'nodeId', 'resourceId', 'pageId'] as const) {
			const value = target[key];
			if (value?.startsWith('@')) {
				const ref = clientRefs[value.slice(1)];
				if (!ref?.[key]) throw new DocumentEditError('INVALID_CLIENT_REF', `批次引用不存在：${value}`);
				target[key] = ref[key];
			}
		}
		return target;
	};
	operations.forEach((operation, index) => {
		try {
			const target = resolve(operation.target);
			const { pkg, component } = locateOwner(document, target);
			if (target.kind === 'project' && operation.props?.settings) {
				for (const setting of ['publish', 'common', 'adaptation'] as const)
					if (Object.hasOwn(operation.props.settings as object, setting)) {
						const entry: ProjectFileTarget = { kind: 'setting', setting };
						affected.set(JSON.stringify(entry), entry);
					}
			}
			if (
				target.kind === 'component' &&
				(operation.props?.name !== undefined ||
					operation.props?.path !== undefined ||
					operation.props?.exported !== undefined)
			)
				touch({ kind: 'package', packageId: target.packageId });
			if (target.kind === 'package' && pkg && (operation.op === 'remove' || operation.props?.name !== undefined))
				for (const item of pkg.listComponents())
					touch({ kind: 'component', packageId: pkg.getId(), componentId: item.getId() });
			if (operation.clientRef && Object.hasOwn(clientRefs, operation.clientRef))
				throw new DocumentEditError('INVALID_CLIENT_REF', 'clientRef 重复');
			let objects: Property[];
			if (operation.op === 'create') {
				const name = String(operation.props?.name ?? '');
				let object: Property;
				switch (target.kind) {
					case 'package': {
						const created = document.createPackage(name).setId(
							generatePackageId(
								document
									.getRoot()
									.listPackages()
									.map((p) => p.getId()),
							),
						);
						target.packageId = created.getId();
						object = created;
						break;
					}
					case 'component': {
						if (!pkg) throw new DocumentEditError('PACKAGE_NOT_FOUND', '包不存在');
						const created = document
							.createComponent(name)
							.setId(generateResourceId(pkg.listResources().map((r) => r.getId())));
						pkg.addResource(created);
						target.componentId = created.getId();
						touch({ kind: 'package', packageId: pkg.getId() });
						object = created;
						break;
					}
					case 'node': {
						if (!component || !operation.type || !/^G[A-Z]\w+$/.test(operation.type))
							throw new DocumentEditError('INVALID_EDIT', '节点创建需要有效组件和节点类型');
						const method = `create${operation.type}`;
						const factory = (document as unknown as Record<string, unknown>)[method];
						if (typeof factory !== 'function')
							throw new DocumentEditError('INVALID_NODE_TYPE', `节点类型无效：${operation.type}`);
						const created = factory.call(document, name) as GObject;
						created.setId(generateChildId(component.listChildren().map((c) => c.getId())));
						component.insertChild(created, operation.toIndex ?? component.listChildren().length);
						component.setIdNum(Math.max(component.getIdNum(), Number(created.getId().slice(1)) + 1));
						target.nodeId = created.getId();
						object = created;
						break;
					}
					case 'controller': {
						if (!component) throw new DocumentEditError('COMPONENT_NOT_FOUND', '组件不存在');
						const created = document.createController(name);
						component.addController(created);
						target.controllerName = name;
						object = created;
						break;
					}
					case 'page': {
						const controller = component?.getController(target.controllerName ?? '');
						if (!controller) throw new DocumentEditError('CONTROLLER_NOT_FOUND', '控制器不存在');
						const ids = new Set(controller.listPages().map((p) => p.getId()));
						let id = 0;
						while (ids.has(String(id))) id++;
						const created = document.createControllerPage(name).setId(String(id));
						controller.addPage(created);
						target.pageId = created.getId();
						object = created;
						break;
					}
					case 'gear': {
						const node = component?.getChildById(target.nodeId ?? '');
						const controller = component?.getController(target.controllerName ?? '');
						if (!node || !controller)
							throw new DocumentEditError('INVALID_GEAR', 'Gear 需要有效节点和控制器');
						const created = document.createGear(name).setController(controller);
						target.index = node.listGears().length;
						node.addGear(created);
						object = created;
						break;
					}
					case 'transition': {
						if (!component) throw new DocumentEditError('COMPONENT_NOT_FOUND', '组件不存在');
						const created = document.createTransition(name);
						component.addTransition(created);
						target.transitionName = name;
						object = created;
						break;
					}
					case 'transition-item': {
						const transition = component?.getTransition(target.transitionName ?? '');
						if (!transition) throw new DocumentEditError('TRANSITION_NOT_FOUND', '动效不存在');
						const created = document.createTransitionItem(name);
						target.index = transition.listItems().length;
						transition.addItem(created);
						object = created;
						break;
					}
					case 'controller-action': {
						const controller = component?.getController(target.controllerName ?? '');
						if (!controller) throw new DocumentEditError('CONTROLLER_NOT_FOUND', '控制器不存在');
						const created = document.createControllerAction(name);
						target.index = controller.listActions().length;
						controller.addAction(created);
						object = created;
						break;
					}
					default:
						throw new DocumentEditError('INVALID_EDIT', '目标不支持创建');
				}
				objects = [object];
				setAuthoringProperties(object, operation.props ?? {});
				if (operation.clientRef) clientRefs[operation.clientRef] = { ...target };
			} else {
				objects = resolveAuthoringTarget(document, target);
				for (const object of objects) {
					if (target.kind === 'node') target.nodeId = (object as GObject).getId();
					if (operation.op === 'update') {
						if (target.kind === 'node')
							updateNode(object as GObject, operation.props ?? {}, operation.scope);
						else setAuthoringProperties(object, operation.props ?? {});
					} else if (operation.op === 'remove') {
						const ref = referenceTarget(target);
						const graph = buildProjectReferenceGraph(document);
						const dependencies = ref ? graph.find(ref) : [];
						if (dependencies.length && !operation.cascade)
							throw new DocumentEditError('DEPENDENCY_EXISTS', '目标仍被引用', 'target', dependencies);
						const unique = [
							...new Map(dependencies.map((e) => [JSON.stringify([e.source, e.field]), e])).values(),
						].sort(
							(a, b) =>
								(b.source.itemIndex ?? b.source.gearIndex ?? b.source.actionIndex ?? 0) -
								(a.source.itemIndex ?? a.source.gearIndex ?? a.source.actionIndex ?? 0),
						);
						for (const edge of unique) {
							clearReference(document, edge);
							touch({
								kind: 'component',
								packageId: edge.source.packageId,
								componentId: edge.source.componentId,
							});
						}
						switch (target.kind) {
							case 'node':
								component!.removeChild(object as GObject);
								break;
							case 'controller':
								component!.removeController(object as Controller);
								break;
							case 'page': {
								const controller = component!.getController(target.controllerName!)!;
								controller.removePage(object as never);
								if (!controller.listPages().length)
									throw new DocumentEditError('EMPTY_CONTROLLER', '删除最后一页时需删除控制器');
								controller.setSelectedIndex(
									Math.min(controller.getSelectedIndex(), controller.listPages().length - 1),
								);
								break;
							}
							case 'gear':
								component!.getChildById(target.nodeId!)!.removeGear(object as Gear);
								break;
							case 'transition':
								component!.removeTransition(object as Transition);
								break;
							case 'transition-item':
								component!.getTransition(target.transitionName!)!.removeItem(object as never);
								break;
							case 'controller-action':
								component!.getController(target.controllerName!)!.removeAction(object as never);
								break;
							case 'resource':
							case 'component':
								pkg!.removeResource(object as never);
								touch({ kind: 'package', packageId: pkg!.getId() });
								break;
							case 'package':
								object.dispose();
								break;
							default:
								throw new DocumentEditError('INVALID_EDIT', '目标不支持删除');
						}
					} else if (operation.op === 'replace' && target.kind === 'node') {
						if (!operation.type || !/^G[A-Z]\w+$/.test(operation.type))
							throw new DocumentEditError('INVALID_NODE_TYPE', '替换需要节点类型');
						const factory = (document as unknown as Record<string, unknown>)[`create${operation.type}`];
						if (typeof factory !== 'function')
							throw new DocumentEditError('INVALID_NODE_TYPE', '节点类型不存在');
						const replacement = factory.call(document, '') as GObject;
						replacement.setId((object as GObject).getId());
						setAuthoringProperties(replacement, operation.props ?? {});
						component!.replaceChild(object as GObject, replacement);
					} else if (operation.op === 'clone' && target.kind === 'component') {
						const destination = operation.destination
							? resolve(operation.destination)
							: { kind: 'package' as const, packageId: pkg!.getId() };
						const destinationPackage = document.getRoot().getPackageById(destination.packageId ?? '');
						if (!destinationPackage) throw new DocumentEditError('PACKAGE_NOT_FOUND', '目标包不存在');
						const copied = cloneProperty(document, object as Component).setId(
							generateResourceId(destinationPackage.listResources().map((r) => r.getId())),
						);
						remapComponentNodes(copied);
						setAuthoringProperties(copied, operation.props ?? {});
						destinationPackage.addResource(copied);
						target.packageId = destinationPackage.getId();
						target.componentId = copied.getId();
						touch({ kind: 'package', packageId: target.packageId });
						if (operation.clientRef) clientRefs[operation.clientRef] = { ...target };
					} else if (operation.op === 'clone' && target.kind === 'node') {
						const destination = operation.destination
							? resolve(operation.destination)
							: { kind: 'component' as const, packageId: pkg!.getId(), componentId: component!.getId() };
						const destinationComponent = resolveAuthoringTarget(document, destination)[0] as Component;
						if (destinationComponent.propertyType !== PropertyType.COMPONENT)
							throw new DocumentEditError('INVALID_TARGET', '节点目标必须是组件');
						const copied = cloneProperty(document, object as GObject, true).setId(
							generateChildId(destinationComponent.listChildren().map((c) => c.getId())),
						);
						copied.setRelations(
							copied.getRelations().map((r) => ({
								...r,
								target: r.target === (object as GObject).getId() ? copied.getId() : r.target,
							})),
						);
						setAuthoringProperties(copied, operation.props ?? {});
						destinationComponent.insertChild(
							copied,
							operation.toIndex ?? destinationComponent.listChildren().length,
						);
						target.packageId = destination.packageId;
						target.componentId = destination.componentId;
						target.nodeId = copied.getId();
						if (operation.clientRef) clientRefs[operation.clientRef] = { ...target };
					} else if (operation.op === 'move' && target.kind === 'node')
						component!.moveChild(object as GObject, operation.toIndex!);
					else throw new DocumentEditError('INVALID_EDIT', `目标不支持操作：${operation.op}`);
				}
			}
			touch(target);
			operationResults.push({ index, op: operation.op, targets: [{ ...target }] });
		} catch (error) {
			if (error instanceof DocumentEditError)
				throw new DocumentEditError(
					error.code,
					error.message,
					`operations[${index}]${error.path ? '.' + error.path : ''}`,
					error.details,
				);
			throw new DocumentEditError(
				'INVALID_EDIT',
				error instanceof Error ? error.message : String(error),
				`operations[${index}]`,
			);
		}
	});
	const diagnostics = compareProjectDiagnostics(before, buildProjectReferenceGraph(document).diagnostics);
	if (diagnostics.added.some((d) => d.severity === 'error'))
		throw new DocumentEditError(
			'REFERENCE_VALIDATION_FAILED',
			'编辑产生了无效引用或身份冲突',
			undefined,
			diagnostics.added,
		);
	return { document, affected: [...affected.values()], clientRefs, operationResults, diagnostics };
}
