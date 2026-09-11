import { XMLBuilder, XMLParser, XMLValidator } from 'fast-xml-parser';
import { generateChildId } from '../utils/id-utils.js';
import { inspectOpaqueProjectXml } from '../io/opaque-project-xml.js';
import { DocumentEditError, type AuthoringTarget } from './document-edit.js';

export interface XmlFragmentOperation {
	op: 'xml';
	action: 'insert' | 'attributes' | 'replace';
	target: AuthoringTarget;
	xml?: string;
	attributes?: Record<string, string | number | boolean | null>;
	bindings?: Record<string, string>;
	index?: number;
}

type Entry = Record<string, unknown>;
const options = {
	preserveOrder: true,
	ignoreAttributes: false,
	attributeNamePrefix: '',
	parseTagValue: false,
	parseAttributeValue: false,
	commentPropName: '#comment',
	cdataPropName: '#cdata',
};
const displayTags = new Set([
	'image',
	'text',
	'richtext',
	'inputtext',
	'graph',
	'group',
	'loader',
	'loader3D',
	'movieclip',
	'component',
	'list',
	'tree',
]);
const tagOf = (entry: Entry) => Object.keys(entry).find((key) => key !== ':@')!;
const attrsOf = (entry: Entry) => (entry[':@'] ??= {}) as Record<string, string | number | boolean>;
const childrenOf = (entry: Entry) => entry[tagOf(entry)] as Entry[];
const find = (entries: Entry[], tag: string, field?: string, value?: string) =>
	entries.find((entry) => tagOf(entry) === tag && (!field || attrsOf(entry)[field] === value));

function parse(xml: string, isFragment = true): Entry[] {
	if (isFragment && new TextEncoder().encode(xml).byteLength > 1024 * 1024)
		throw new DocumentEditError('XML_LIMIT_EXCEEDED', 'XML 超过 1 MiB');
	if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml))
		throw new DocumentEditError('XML_ENTITY_FORBIDDEN', 'XML 外部实体与 DTD 不可用');
	const validated = XMLValidator.validate(xml);
	if (validated !== true) throw new DocumentEditError('INVALID_XML', validated.err.msg);
	const tree = new XMLParser(options).parse(xml) as Entry[];
	const stack = tree.map((entry) => ({ entry, depth: 0 }));
	while (stack.length) {
		const { entry, depth } = stack.pop()!;
		if (depth > 64) throw new DocumentEditError('XML_LIMIT_EXCEEDED', 'XML 嵌套深度超过 64');
		const children = childrenOf(entry);
		if (Array.isArray(children)) for (const child of children) stack.push({ entry: child, depth: depth + 1 });
	}
	return tree;
}

function locate(root: Entry, target: AuthoringTarget): { entry: Entry; siblings: Entry[] } {
	const children = childrenOf(root);
	if (target.kind === 'component') return { entry: root, siblings: [root] };
	const displayList = find(children, 'displayList');
	const nodes = displayList ? childrenOf(displayList) : [];
	const node = nodes.find((entry) => attrsOf(entry).id === target.nodeId);
	const controller = find(children, 'controller', 'name', target.controllerName);
	const transition = find(children, 'transition', 'name', target.transitionName);
	let siblings: Entry[] = children;
	let entry: Entry | undefined;
	switch (target.kind) {
		case 'node':
			entry = node;
			siblings = nodes;
			break;
		case 'controller':
			entry = controller;
			break;
		case 'transition':
			entry = transition;
			break;
		case 'gear':
			siblings = node ? childrenOf(node) : [];
			entry = siblings.filter((e) => tagOf(e).startsWith('gear'))[target.index ?? -1];
			break;
		case 'controller-action':
			siblings = controller ? childrenOf(controller) : [];
			entry = siblings.filter((e) => tagOf(e) === 'action')[target.index ?? -1];
			break;
		case 'transition-item':
			siblings = transition ? childrenOf(transition) : [];
			entry = siblings.filter((e) => tagOf(e) === 'item')[target.index ?? -1];
			break;
		default:
			throw new DocumentEditError('INVALID_XML_TARGET', 'XML 目标必须属于组件定义');
	}
	if (!entry) throw new DocumentEditError('XML_TARGET_NOT_FOUND', 'XML 目标不存在', 'target');
	return { entry, siblings };
}

/**
 * Produces a component XML overlay. The caller validates the resulting document graph.
 */
export function editComponentXml(
	source: string,
	operation: XmlFragmentOperation,
): { xml: string; idMap: Record<string, string>; findings: ReturnType<typeof inspectOpaqueProjectXml> } {
	const tree = parse(source, false);
	const root = find(tree, 'component');
	if (!root) throw new DocumentEditError('INVALID_XML', '组件 XML 缺少 component 根');
	const target = locate(root, operation.target);
	const idMap: Record<string, string> = {};
	if (operation.action === 'attributes') {
		for (const [key, value] of Object.entries(operation.attributes ?? {})) {
			if (['id', '__proto__', 'prototype', 'constructor'].includes(key) || !/^[A-Za-z_][\w.-]*$/.test(key))
				throw new DocumentEditError('XML_IDENTITY_PROTECTED', `XML 属性不可更新：${key}`);
			if (value === null) delete attrsOf(target.entry)[key];
			else if (
				['string', 'number', 'boolean'].includes(typeof value) &&
				(typeof value !== 'number' || Number.isFinite(value))
			)
				attrsOf(target.entry)[key] = value;
			else throw new DocumentEditError('INVALID_XML_ATTRIBUTE', `XML 属性值无效：${key}`);
		}
	} else {
		const fragmentRoot = find(parse(`<fragment>${operation.xml ?? ''}</fragment>`), 'fragment')!;
		const entries = childrenOf(fragmentRoot).filter((entry) => !tagOf(entry).startsWith('#'));
		if (!entries.length) throw new DocumentEditError('INVALID_XML', 'XML 片段不能为空');
		if (operation.action === 'replace' && entries.length !== 1)
			throw new DocumentEditError('INVALID_XML', '替换要求单一根元素');
		const displayList = find(childrenOf(root), 'displayList');
		const existingIds = new Set(
			(displayList ? childrenOf(displayList) : [])
				.map((entry) => String(attrsOf(entry).id ?? ''))
				.filter(Boolean),
		);
		const labels = new Set<string>();
		const replacingRoot = operation.action === 'replace' && operation.target.kind === 'component';
		const allocate = (entry: Entry, display: boolean) => {
			if (!display) return;
			const label = String(attrsOf(entry).id ?? '');
			if (label && labels.has(label))
				throw new DocumentEditError('DUPLICATE_FRAGMENT_ID', `片段 ID 重复：${label}`);
			if (label) labels.add(label);
			const id =
				operation.action === 'replace' && operation.target.kind === 'node'
					? operation.target.nodeId!
					: replacingRoot && existingIds.has(label)
						? label
						: generateChildId(existingIds);
			existingIds.add(id);
			if (label) idMap[label] = id;
			attrsOf(entry).id = id;
		};
		for (const entry of entries) {
			if (replacingRoot) {
				delete attrsOf(entry).id;
				const list = find(childrenOf(entry), 'displayList');
				for (const child of list ? childrenOf(list) : []) allocate(child, displayTags.has(tagOf(child)));
			} else
				allocate(
					entry,
					displayTags.has(tagOf(entry)) &&
						(operation.target.kind === 'component' ||
							(operation.target.kind === 'node' && operation.action === 'replace')),
				);
		}
		const mapping = { ...operation.bindings, ...idMap };
		const remap = (entry: Entry, parent: string) => {
			const tag = tagOf(entry);
			const attrs = attrsOf(entry);
			const fields =
				tag === 'relation'
					? ['target']
					: tag === 'item' && parent === 'transition'
						? ['target']
						: tag === 'action'
							? ['objectId']
							: displayTags.has(tag)
								? ['group', 'mask']
								: [];
			for (const key of fields) {
				const value = String(attrs[key] ?? '');
				if (Object.hasOwn(mapping, value)) attrs[key] = mapping[value]!;
			}
			if (Array.isArray(childrenOf(entry))) for (const child of childrenOf(entry)) remap(child, tag);
		};
		for (const entry of entries) remap(entry, tagOf(target.entry));
		if (operation.action === 'replace') {
			if (operation.target.kind === 'component') {
				if (tagOf(entries[0]!) !== 'component')
					throw new DocumentEditError('INVALID_XML', '组件根必须保持 component 类型');
				tree.splice(tree.indexOf(root), 1, entries[0]!);
			} else {
				if (['controller', 'transition'].includes(operation.target.kind))
					attrsOf(entries[0]!).name = attrsOf(target.entry).name!;
				target.siblings.splice(target.siblings.indexOf(target.entry), 1, entries[0]!);
			}
		} else {
			let offset = operation.index;
			for (const entry of entries) {
				let parent = target.entry;
				if (operation.target.kind === 'component' && displayTags.has(tagOf(entry))) {
					parent = find(childrenOf(root), 'displayList') ?? { displayList: [] };
					if (!childrenOf(root).includes(parent)) childrenOf(root).push(parent);
				}
				const siblings = childrenOf(parent);
				const index = offset ?? siblings.length;
				if (!Number.isInteger(index) || index < 0 || index > siblings.length)
					throw new DocumentEditError('INVALID_XML_INDEX', 'XML 插入位置无效');
				siblings.splice(index, 0, entry);
				if (offset !== undefined) offset++;
			}
		}
	}
	const xml = new XMLBuilder({ ...options, format: true, suppressEmptyNode: true }).build(tree) as string;
	return { xml, idMap, findings: inspectOpaqueProjectXml('component', xml) };
}

/**
 * Reads a single native structure, including its preserved extension attributes.
 */
export function readComponentXmlFragment(source: string, target: AuthoringTarget): string {
	const root = find(parse(source, false), 'component');
	if (!root) throw new DocumentEditError('INVALID_XML', '组件 XML 缺少 component 根');
	return new XMLBuilder(options).build([locate(root, target).entry]);
}
