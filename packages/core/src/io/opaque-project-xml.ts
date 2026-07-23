import { parseXMLPreserveOrder } from '../utils/xml-utils.js';
import {
	PROJECT_XML_PROTOCOL,
	type XmlNodeProtocol,
	listXmlAttrNames,
} from './project-xml-protocol.js';

export type OpaqueProjectXmlKind = 'project' | 'package' | 'branch' | 'component';

export interface OpaqueXmlFinding {
	kind: 'attribute' | 'element';
	name: string;
	path: string;
}

interface XmlSchema {
	attrs: Set<string>;
	children: Map<string, XmlSchema>;
	variants: Map<string, XmlSchema>;
}

interface XmlElement {
	kind: 'element';
	name: string;
	attrs: Record<string, unknown>;
	children: XmlAstNode[];
}

interface XmlText {
	kind: 'text';
	value: string;
}

type XmlAstNode = XmlElement | XmlText;
type OrderedXmlEntry = Record<string, unknown>;

function emptySchema(): XmlSchema {
	return {
		attrs: new Set(),
		children: new Map(),
		variants: new Map(),
	};
}

function mergeProtocols(...protocols: XmlNodeProtocol[]): XmlNodeProtocol {
	return {
		attrs: Object.assign({}, ...protocols.map((protocol) => protocol.attrs)),
		children: Object.assign({}, ...protocols.map((protocol) => protocol.children ?? {})),
		containers: Object.assign({}, ...protocols.map((protocol) => protocol.containers ?? {})),
	};
}

function schemaFromProtocol(protocol: XmlNodeProtocol): XmlSchema {
	const schema = emptySchema();
	for (const name of listXmlAttrNames(protocol)) schema.attrs.add(name);

	for (const [name, childProtocol] of Object.entries(protocol.children ?? {})) {
		schema.children.set(name.toLowerCase(), schemaFromProtocol(childProtocol));
	}

	for (const [containerName, container] of Object.entries(protocol.containers ?? {})) {
		const containerSchema = emptySchema();
		for (const [name, itemProtocol] of Object.entries(container.items)) {
			containerSchema.variants.set(
				name.toLowerCase(),
				schemaFromProtocol(mergeProtocols(PROJECT_XML_PROTOCOL.displayObject, itemProtocol)),
			);
		}
		schema.children.set(containerName.toLowerCase(), containerSchema);
	}

	return schema;
}

function packageResourceSchema(tagName: string): XmlSchema {
	const protocols = [PROJECT_XML_PROTOCOL.packageResource];
	switch (tagName.toLowerCase()) {
		case 'image':
			protocols.push(PROJECT_XML_PROTOCOL.packageImageResource);
			break;
		case 'font':
			protocols.push(PROJECT_XML_PROTOCOL.packageFontResource);
			break;
		case 'spine':
		case 'dragonbones':
			protocols.push(PROJECT_XML_PROTOCOL.packageSkeletonResource);
			break;
		default:
			break;
	}
	return schemaFromProtocol(mergeProtocols(...protocols));
}

function createProjectSchema(): XmlSchema {
	const schema = emptySchema();
	for (const attr of ['id', 'type', 'version']) schema.attrs.add(attr);
	return schema;
}

function createPackageSchema(branch: boolean): XmlSchema {
	const schema = schemaFromProtocol(
		branch ? PROJECT_XML_PROTOCOL.branchDescription : PROJECT_XML_PROTOCOL.packageDescription,
	);
	const resources = emptySchema();
	for (const tagName of [
		'image',
		'component',
		'font',
		'sound',
		'movieclip',
		'swf',
		'misc',
		'atlas',
		'spine',
		'dragonbones',
	]) {
		resources.variants.set(tagName, packageResourceSchema(tagName));
	}
	schema.children.set('resources', resources);
	if (!branch) schema.children.set('publish', schemaFromProtocol(PROJECT_XML_PROTOCOL.packagePublish));
	return schema;
}

const PROJECT_SCHEMAS: Record<OpaqueProjectXmlKind, XmlSchema> = {
	project: createProjectSchema(),
	package: createPackageSchema(false),
	branch: createPackageSchema(true),
	component: schemaFromProtocol(PROJECT_XML_PROTOCOL.componentRoot),
};

function normalizeAttributes(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const attrs: Record<string, unknown> = {};
	for (const [key, attrValue] of Object.entries(value as Record<string, unknown>)) {
		attrs[key.startsWith('@_') ? key.slice(2) : key] = attrValue;
	}
	return attrs;
}

function nodesFromEntry(entry: OrderedXmlEntry): XmlAstNode[] {
	const nodes: XmlAstNode[] = [];
	const attrs = normalizeAttributes(entry[':@']);
	for (const [name, value] of Object.entries(entry)) {
		if (name === ':@') continue;
		if (name === '#text') {
			nodes.push({ kind: 'text', value: String(value ?? '') });
			continue;
		}
		if (name.startsWith('?')) continue;
		if (name.startsWith('#')) continue;

		const children = Array.isArray(value)
			? value.flatMap((child) => (
				child && typeof child === 'object' && !Array.isArray(child)
					? nodesFromEntry(child as OrderedXmlEntry)
					: []
			))
			: [];
		nodes.push({
			kind: 'element',
			name,
			attrs: { ...attrs },
			children,
		});
	}
	return nodes;
}

function parseDocument(xml: string): XmlElement {
	const entries = parseXMLPreserveOrder(xml);
	for (const entry of entries) {
		const root = nodesFromEntry(entry).find((node): node is XmlElement => node.kind === 'element');
		if (root) return root;
	}
	throw new Error('XML document does not contain a root element.');
}

function cloneNode<T extends XmlAstNode>(node: T): T {
	if (node.kind === 'text') return { ...node } as T;
	return {
		...node,
		attrs: { ...node.attrs },
		children: node.children.map((child) => cloneNode(child)),
	} as T;
}

function childSchema(schema: XmlSchema, name: string): XmlSchema | undefined {
	const normalized = name.toLowerCase();
	return schema.children.get(normalized) ?? schema.variants.get(normalized);
}

function identityValue(element: XmlElement, key: string): string {
	const value = element.attrs[key];
	return value === undefined || value === null ? '' : String(value);
}

function findGeneratedMatch(
	source: XmlElement,
	generated: XmlAstNode[],
	used: Set<number>,
): number {
	const candidates = generated
		.map((node, index) => ({ node, index }))
		.filter(({ node, index }) => (
			node.kind === 'element'
			&& node.name.toLowerCase() === source.name.toLowerCase()
			&& !used.has(index)
		));

	let hasStableIdentity = false;
	for (const identity of ['id', 'name']) {
		const value = identityValue(source, identity);
		if (!value) continue;
		hasStableIdentity = true;
		const match = candidates.find(({ node }) => (
			node.kind === 'element' && identityValue(node, identity) === value
		));
		if (match) return match.index;
	}
	if (hasStableIdentity) return -1;

	const type = identityValue(source, 'type');
	const target = identityValue(source, 'target');
	if (type || target) {
		const match = candidates.find(({ node }) => (
			node.kind === 'element'
			&& identityValue(node, 'type') === type
			&& identityValue(node, 'target') === target
		));
		if (match) return match.index;
	}

	return candidates[0]?.index ?? -1;
}

function mergeElement(source: XmlElement, generated: XmlElement, schema: XmlSchema): XmlElement {
	const result = cloneNode(generated);
	for (const [name, value] of Object.entries(source.attrs)) {
		if (!schema.attrs.has(name) && !Object.hasOwn(result.attrs, name)) {
			result.attrs[name] = value;
		}
	}

	const usedGenerated = new Set<number>();
	const opaqueAfter = new Map<number, XmlAstNode[]>();
	let lastMatchedIndex = -1;

	for (const sourceChild of source.children) {
		if (sourceChild.kind === 'text') {
			const bucket = opaqueAfter.get(lastMatchedIndex) ?? [];
			bucket.push(cloneNode(sourceChild));
			opaqueAfter.set(lastMatchedIndex, bucket);
			continue;
		}

		const schemaForChild = childSchema(schema, sourceChild.name);
		if (!schemaForChild) {
			const bucket = opaqueAfter.get(lastMatchedIndex) ?? [];
			bucket.push(cloneNode(sourceChild));
			opaqueAfter.set(lastMatchedIndex, bucket);
			continue;
		}

		const matchIndex = findGeneratedMatch(sourceChild, result.children, usedGenerated);
		if (matchIndex < 0) {
			// A known owner was deleted. Its opaque attributes and descendants
			// intentionally disappear with it.
			continue;
		}

		const generatedChild = result.children[matchIndex];
		if (generatedChild?.kind !== 'element') continue;
		result.children[matchIndex] = mergeElement(sourceChild, generatedChild, schemaForChild);
		usedGenerated.add(matchIndex);
		lastMatchedIndex = matchIndex;
	}

	const mergedChildren: XmlAstNode[] = [];
	for (const node of opaqueAfter.get(-1) ?? []) mergedChildren.push(node);
	for (let index = 0; index < result.children.length; index++) {
		const child = result.children[index];
		if (child) mergedChildren.push(child);
		for (const node of opaqueAfter.get(index) ?? []) mergedChildren.push(node);
	}
	result.children = mergedChildren;
	return result;
}

function escapeAttribute(value: unknown): string {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/\r\n/g, '&#xA;')
		.replace(/[\r\n]/g, '&#xA;')
		.replace(/\t/g, '&#x9;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function escapeText(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function renderElement(element: XmlElement, indent = ''): string {
	const attrs = Object.entries(element.attrs)
		.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
		.join('');
	if (element.children.length === 0) return `${indent}<${element.name}${attrs}/>`;
	if (element.children.every((child) => child.kind === 'text')) {
		const text = element.children
			.map((child) => child.kind === 'text' ? escapeText(child.value) : '')
			.join('');
		return `${indent}<${element.name}${attrs}>${text}</${element.name}>`;
	}

	const childIndent = `${indent}  `;
	const children = element.children
		.map((child) => (
			child.kind === 'text'
				? `${childIndent}${escapeText(child.value)}`
				: renderElement(child, childIndent)
		))
		.join('\n');
	return `${indent}<${element.name}${attrs}>\n${children}\n${indent}</${element.name}>`;
}

function findingPath(parentPath: string, element: XmlElement): string {
	const id = identityValue(element, 'id');
	if (id) return `${parentPath}/${element.name}#${id}`;
	const name = identityValue(element, 'name');
	if (name) return `${parentPath}/${element.name}[name="${name}"]`;
	return `${parentPath}/${element.name}`;
}

function inspectElement(
	element: XmlElement,
	schema: XmlSchema,
	path: string,
	findings: OpaqueXmlFinding[],
): void {
	for (const name of Object.keys(element.attrs)) {
		if (!schema.attrs.has(name)) {
			findings.push({
				kind: 'attribute',
				name,
				path: `${path}/@${name}`,
			});
		}
	}

	for (const child of element.children) {
		if (child.kind !== 'element') continue;
		const nextPath = findingPath(path, child);
		const schemaForChild = childSchema(schema, child.name);
		if (!schemaForChild) {
			findings.push({
				kind: 'element',
				name: child.name,
				path: nextPath,
			});
			continue;
		}
		inspectElement(child, schemaForChild, nextPath, findings);
	}
}

/**
 * Merges unknown attributes and elements from source XML into canonical XML.
 *
 * Known fields always come from the generated document. Unknown content is
 * structurally retained and follows its nearest stable known owner.
 */
export function preserveOpaqueProjectXml(
	kind: OpaqueProjectXmlKind,
	sourceXml: string,
	generatedXml: string,
): string {
	const source = parseDocument(sourceXml);
	const generated = parseDocument(generatedXml);
	if (source.name.toLowerCase() !== generated.name.toLowerCase()) {
		throw new Error(
			`Cannot preserve opaque XML: source root "${source.name}" does not match generated root "${generated.name}".`,
		);
	}
	const merged = mergeElement(source, generated, PROJECT_SCHEMAS[kind]);
	return `<?xml version="1.0" encoding="utf-8"?>\n${renderElement(merged)}\n`;
}

/** Reports unknown attributes and elements without making them writable. */
export function inspectOpaqueProjectXml(
	kind: OpaqueProjectXmlKind,
	xml: string,
): OpaqueXmlFinding[] {
	const root = parseDocument(xml);
	const findings: OpaqueXmlFinding[] = [];
	inspectElement(root, PROJECT_SCHEMAS[kind], `/${root.name}`, findings);
	return findings;
}
