import { ControllerActionType, PropertyType, TransitionActionType } from '../constants.js';
import type { Document } from '../document.js';
import type { Component, GObject } from '../properties/index.js';
import { parseURL } from '../utils/id-utils.js';
import { buildResourceReferenceIndex } from './resource-reference-index.js';
import type { ProjectFileTarget } from '../io/project-files.js';

export interface ProjectReferenceTarget {
	kind: 'package' | 'resource' | 'node' | 'controller' | 'page' | 'transition';
	packageId: string;
	componentId?: string;
	controller?: string;
	id: string;
}

export interface ProjectReferenceSource {
	packageId: string;
	componentId: string;
	nodeId?: string;
	controller?: string;
	transition?: string;
	gearIndex?: number;
	itemIndex?: number;
	actionIndex?: number;
}

export interface ProjectReferenceEdge {
	source: ProjectReferenceSource;
	target: ProjectReferenceTarget;
	field: string;
	cascade: 'clear-field' | 'remove-owner' | 'remove-binding' | 'remove-item' | 'unsupported';
	expectedType?: string;
}

export interface ProjectDiagnostic {
	severity: 'error' | 'warning';
	code: string;
	message: string;
	path: string;
	reference?: ProjectReferenceEdge;
}

export function projectReferenceKey(target: ProjectReferenceTarget): string {
	return JSON.stringify([
		target.kind,
		target.packageId,
		target.componentId ?? '',
		target.controller ?? '',
		target.id,
	]);
}

/**
 * A serializable dependency snapshot. Local IDs are qualified by their owner.
 */
export interface ProjectReferenceGraph {
	edges: ProjectReferenceEdge[];
	diagnostics: ProjectDiagnostic[];
	find(target: ProjectReferenceTarget): ProjectReferenceEdge[];
}

function sourcePath(source: ProjectReferenceSource, field: string): string {
	return [
		source.packageId,
		source.componentId,
		source.nodeId,
		source.controller,
		source.transition,
		source.gearIndex === undefined ? undefined : `gear[${source.gearIndex}]`,
		source.itemIndex === undefined ? undefined : `item[${source.itemIndex}]`,
		source.actionIndex === undefined ? undefined : `action[${source.actionIndex}]`,
		field,
	]
		.filter((v) => v !== undefined)
		.join('/');
}

function stringGetter(owner: object, name: string): string {
	const fn = (owner as Record<string, unknown>)[name];
	return typeof fn === 'function' ? String(fn.call(owner) ?? '') : '';
}

function instanceSource(
	document: Document,
	packageId: string,
	owner: Component,
	nodeId: string,
): { packageId: string; component: Component } | undefined {
	if (!nodeId) return { packageId, component: owner };
	const node = owner.getChildById(nodeId);
	if (!node) return undefined;
	const src = stringGetter(node, 'getSrc');
	const ref = parseURL(src) ?? { packageId: stringGetter(node, 'getPackageId') || packageId, resourceId: src };
	const resource = document.getRoot().getPackageById(ref.packageId)?.getResourceById(ref.resourceId);
	return resource?.propertyType === PropertyType.COMPONENT
		? { packageId: ref.packageId, component: resource as Component }
		: undefined;
}

/**
 * Inspects resource and component-local dependencies without changing the model.
 */
export function buildProjectReferenceGraph(document: Document): ProjectReferenceGraph {
	const edges: ProjectReferenceEdge[] = [];
	const diagnostics: ProjectDiagnostic[] = [];
	const targets = new Map<string, string>();
	const register = (target: ProjectReferenceTarget, type: string, duplicateCode: string) => {
		const key = projectReferenceKey(target);
		if (!target.id)
			diagnostics.push({
				severity: 'error',
				code: 'MISSING_IDENTITY',
				message: `${target.kind} 缺少标识`,
				path: key,
			});
		else if (targets.has(key))
			diagnostics.push({
				severity: 'error',
				code: duplicateCode,
				message: `${target.kind} 标识重复：${target.id}`,
				path: key,
			});
		targets.set(key, type);
	};
	for (const pkg of document.getRoot().listPackages()) {
		const packageId = pkg.getId();
		register({ kind: 'package', packageId, id: packageId }, pkg.propertyType, 'DUPLICATE_PACKAGE_ID');
		for (const resource of pkg.listResources())
			register(
				{ kind: 'resource', packageId, id: resource.getId() },
				resource.propertyType,
				'DUPLICATE_RESOURCE_ID',
			);
		for (const component of pkg.listComponents()) {
			const scope = { packageId, componentId: component.getId() };
			for (const child of component.listChildren())
				register({ ...scope, kind: 'node', id: child.getId() }, child.propertyType, 'DUPLICATE_NODE_ID');
			for (const controller of component.listControllers()) {
				register(
					{ ...scope, kind: 'controller', id: controller.getName() },
					controller.propertyType,
					'DUPLICATE_CONTROLLER_NAME',
				);
				for (const page of controller.listPages())
					register(
						{ ...scope, kind: 'page', controller: controller.getName(), id: page.getId() },
						page.propertyType,
						'DUPLICATE_PAGE_ID',
					);
				const pages = controller.listPages();
				if (
					pages.length &&
					(controller.getSelectedIndex() < -1 || controller.getSelectedIndex() >= pages.length)
				) {
					diagnostics.push({
						severity: 'error',
						code: 'INVALID_CONTROLLER_SELECTION',
						message: '控制器选中页超出页面范围',
						path: sourcePath({ ...scope, controller: controller.getName() }, 'selectedIndex'),
					});
				}
			}
			for (const transition of component.listTransitions())
				register(
					{ ...scope, kind: 'transition', id: transition.getName() },
					transition.propertyType,
					'DUPLICATE_TRANSITION_NAME',
				);
		}
	}
	for (const ref of buildResourceReferenceIndex(document).list()) {
		if (ref.source.field.startsWith('gear.') || ref.source.field.startsWith('transitions.items[')) continue;
		const expectedType =
			ref.source.field === 'src'
				? (
						{ GImage: 'ImageResource', GMovieClip: 'MovieClipResource', GComponent: 'Component' } as Record<
							string,
							string
						>
					)[ref.source.ownerType]
				: ref.source.field === 'font'
					? 'FontResource'
					: [
								'defaultItem',
								'dropdown',
								'vtScrollBarRes',
								'hzScrollBarRes',
								'headerRes',
								'footerRes',
							].includes(ref.source.field) || /^listItems\[\d+\]\.url$/.test(ref.source.field)
						? 'Component'
						: /(?:^sound$|Sound$)/.test(ref.source.field)
							? 'SoundResource'
							: undefined;
		edges.push({
			source: {
				packageId: ref.source.packageId,
				componentId: ref.source.componentId,
				nodeId: ref.source.objectId,
			},
			target: { kind: 'resource', packageId: ref.target.packageId, id: ref.target.resourceId },
			field: ref.source.field,
			cascade: ref.cascadeAction,
			...(expectedType ? { expectedType } : {}),
		});
	}
	const resourceEdges = (
		value: unknown,
		source: ProjectReferenceSource,
		field: string,
		cascade: ProjectReferenceEdge['cascade'],
		expectedType?: string,
	): void => {
		if (typeof value === 'string') {
			for (const match of value.matchAll(/ui:\/\/([a-zA-Z0-9]{8})([a-zA-Z0-9_./-]+)/g))
				edges.push({
					source,
					field,
					cascade,
					target: { kind: 'resource', packageId: match[1]!, id: match[2]! },
					...(expectedType ? { expectedType } : {}),
				});
		} else if (Array.isArray(value))
			value.forEach((entry, index) => resourceEdges(entry, source, `${field}[${index}]`, cascade, expectedType));
		else if (value && typeof value === 'object')
			for (const [key, entry] of Object.entries(value))
				resourceEdges(entry, source, `${field}.${key}`, cascade, expectedType);
	};
	for (const pkg of document.getRoot().listPackages()) {
		for (const component of pkg.listComponents()) {
			const scope = { packageId: pkg.getId(), componentId: component.getId() };
			const nodeEdge = (
				source: ProjectReferenceSource,
				id: string,
				field: string,
				cascade: ProjectReferenceEdge['cascade'],
				expectedType?: string,
			) => {
				if (!id || id === component.getId()) return;
				edges.push({
					source,
					target: { ...scope, kind: 'node', id },
					field,
					cascade,
					...(expectedType ? { expectedType } : {}),
				});
			};
			for (const owner of [component, ...component.listChildren()]) {
				const source = { ...scope, ...(owner === component ? {} : { nodeId: owner.getId() }) };
				const relations = (owner as GObject).getRelations?.() ?? [];
				relations.forEach((relation, i) =>
					nodeEdge(source, relation.target, `relations[${i}].target`, 'clear-field'),
				);
				nodeEdge(source, stringGetter(owner, 'getGroup'), 'group', 'clear-field', PropertyType.G_GROUP);
				if (owner === component) continue;
				const related = stringGetter(owner, 'getInstanceController');
				if (related) {
					edges.push({
						source,
						target: { ...scope, kind: 'controller', id: related },
						field: 'instanceController',
						cascade: 'clear-field',
					});
					const page = stringGetter(owner, 'getInstancePage');
					if (page)
						edges.push({
							source,
							target: { ...scope, kind: 'page', controller: related, id: page },
							field: 'instancePage',
							cascade: 'clear-field',
						});
				}
				const overrides = stringGetter(owner, 'getControllerOverrides').split(',').filter(Boolean);
				const instance = overrides.length
					? instanceSource(document, scope.packageId, component, owner.getId())
					: undefined;
				if (instance) {
					const instanceScope = { packageId: instance.packageId, componentId: instance.component.getId() };
					if (overrides.length % 2)
						diagnostics.push({
							severity: 'error',
							code: 'INVALID_CONTROLLER_OVERRIDE',
							message: '实例控制器覆盖需要名称与页面成对出现',
							path: sourcePath(source, 'controllerOverrides'),
						});
					for (let i = 0; i + 1 < overrides.length; i += 2) {
						const controller = overrides[i]!;
						edges.push({
							source,
							target: { ...instanceScope, kind: 'controller', id: controller },
							field: `controllerOverrides[${i}]`,
							cascade: 'clear-field',
						});
						edges.push({
							source,
							target: { ...instanceScope, kind: 'page', controller, id: overrides[i + 1]! },
							field: `controllerOverrides[${i + 1}]`,
							cascade: 'clear-field',
						});
					}
				}
				(owner as GObject).listGears().forEach((gear, gearIndex) => {
					const controller =
						gear.getController()?.getName() || String(gear.getExtras().controllerName ?? '<missing>');
					const gearSource = { ...source, gearIndex };
					for (const [field, value] of [
						['values', gear.getValues()],
						['defaultValue', gear.getDefaultValue()],
						['pageValues', gear.getPageValues()],
					] as const)
						resourceEdges(value, gearSource, field, 'remove-binding');
					edges.push({
						source: gearSource,
						target: { ...scope, kind: 'controller', id: controller },
						field: 'controller',
						cascade: 'remove-binding',
					});
					const pages = new Set([
						...gear.getPages().split(',').filter(Boolean),
						...Object.keys(gear.getPageValues()),
					]);
					for (const id of pages)
						edges.push({
							source: gearSource,
							target: { ...scope, kind: 'page', controller, id },
							field: 'pages',
							cascade: 'remove-binding',
						});
				});
			}
			nodeEdge(scope, component.getMask(), 'mask', 'clear-field');
			for (const controller of component.listControllers()) {
				controller.listActions().forEach((action, actionIndex) => {
					const source = { ...scope, controller: controller.getName(), actionIndex };
					for (const [field, pages] of [
						['fromPage', action.getFromPage()],
						['toPage', action.getToPage()],
					] as const) {
						for (const id of pages)
							if (id)
								edges.push({
									source,
									target: { ...scope, kind: 'page', controller: controller.getName(), id },
									field,
									cascade: 'remove-item',
								});
					}
					if (action.getActionType() === ControllerActionType.PlayTransition && action.getTransitionName()) {
						edges.push({
							source,
							target: { ...scope, kind: 'transition', id: action.getTransitionName() },
							field: 'transitionName',
							cascade: 'remove-item',
						});
					} else if (action.getActionType() === ControllerActionType.ChangePage) {
						nodeEdge(source, action.getObjectId(), 'objectId', 'remove-item');
						const target = instanceSource(document, scope.packageId, component, action.getObjectId());
						if (target && action.getControllerName()) {
							const owner = { packageId: target.packageId, componentId: target.component.getId() };
							edges.push({
								source,
								target: { ...owner, kind: 'controller', id: action.getControllerName() },
								field: 'controllerName',
								cascade: 'remove-item',
							});
							const page = action.getTargetPage();
							if (page && !page.startsWith('~'))
								edges.push({
									source,
									target: {
										...owner,
										kind: 'page',
										controller: action.getControllerName(),
										id: page,
									},
									field: 'targetPage',
									cascade: 'remove-item',
								});
						}
					}
				});
			}
			for (const transition of component.listTransitions()) {
				transition.listItems().forEach((item, itemIndex) => {
					const source = { ...scope, transition: transition.getName(), itemIndex };
					const resourceType =
						item.getActionType() === TransitionActionType.Sound ? 'SoundResource' : undefined;
					resourceEdges(item.getStartValue(), source, 'startValue', 'remove-item', resourceType);
					resourceEdges(item.getEndValue(), source, 'endValue', 'remove-item', resourceType);
					nodeEdge(source, item.getTargetId(), 'targetId', 'remove-item');
					if (item.getActionType() === TransitionActionType.Transition) {
						const target = instanceSource(document, scope.packageId, component, item.getTargetId());
						const name = item.getStartValue()[0];
						if (target && typeof name === 'string' && name)
							edges.push({
								source,
								target: {
									kind: 'transition',
									packageId: target.packageId,
									componentId: target.component.getId(),
									id: name,
								},
								field: 'startValue[0]',
								cascade: 'remove-item',
							});
					}
				});
			}
		}
	}
	for (const edge of edges) {
		const type = targets.get(projectReferenceKey(edge.target));
		if (type === undefined)
			diagnostics.push({
				severity: 'error',
				code: `BROKEN_${edge.target.kind.toUpperCase()}_REFERENCE`,
				message: `引用目标不存在：${edge.target.id}`,
				path: sourcePath(edge.source, edge.field),
				reference: edge,
			});
		else if (edge.expectedType && edge.expectedType !== type)
			diagnostics.push({
				severity: 'error',
				code: 'REFERENCE_TYPE_MISMATCH',
				message: `引用目标类型应为 ${edge.expectedType}，实际为 ${type}`,
				path: sourcePath(edge.source, edge.field),
				reference: edge,
			});
	}
	return {
		edges,
		diagnostics,
		find: (target) => edges.filter((edge) => projectReferenceKey(edge.target) === projectReferenceKey(target)),
	};
}

export function blockingProjectDiagnostics(
	diagnostics: ReturnType<typeof compareProjectDiagnostics>,
	affected: readonly ProjectFileTarget[],
): ProjectDiagnostic[] {
	return [
		...diagnostics.added,
		...diagnostics.existing.filter((d) =>
			affected.some((target) => {
				if (target.kind !== 'component') return false;
				const prefix = `${target.packageId}/${target.componentId}/`;
				if (d.path.startsWith(prefix)) return true;
				const dependency = d.reference?.target;
				return (
					dependency?.packageId === target.packageId &&
					(dependency.componentId === target.componentId ||
						(dependency.kind === 'resource' && dependency.id === target.componentId))
				);
			}),
		),
	].filter((d) => d.severity === 'error');
}

/**
 * Compares stable diagnostic identities, including referenced targets.
 */
export function compareProjectDiagnostics(
	before: readonly ProjectDiagnostic[],
	after: readonly ProjectDiagnostic[],
): { existing: ProjectDiagnostic[]; added: ProjectDiagnostic[]; resolved: ProjectDiagnostic[] } {
	const key = (d: ProjectDiagnostic) => JSON.stringify([d.code, d.path, d.reference?.target]);
	const old = new Set(before.map(key));
	const current = new Set(after.map(key));
	return {
		existing: after.filter((d) => old.has(key(d))),
		added: after.filter((d) => !old.has(key(d))),
		resolved: before.filter((d) => !current.has(key(d))),
	};
}
