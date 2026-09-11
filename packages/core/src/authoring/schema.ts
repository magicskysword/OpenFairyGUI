import type { Property } from '../properties/index.js';
import { DocumentEditError, readAuthoringProperties } from './document-edit.js';

export interface AuthoringJsonSchema {
	type?: string | string[];
	const?: unknown;
	enum?: unknown[];
	properties?: Record<string, AuthoringJsonSchema>;
	required?: string[];
	additionalProperties?: boolean | AuthoringJsonSchema;
	items?: AuthoringJsonSchema;
	oneOf?: AuthoringJsonSchema[];
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	description?: string;
}
const text: AuthoringJsonSchema = { type: 'string', minLength: 1 };
const index: AuthoringJsonSchema = { type: 'integer', minimum: 0 };
const object = (properties: Record<string, AuthoringJsonSchema>, required: string[]): AuthoringJsonSchema => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false,
});
export const AUTHORING_TARGET_SCHEMA = object(
	{
		kind: {
			enum: [
				'project',
				'package',
				'resource',
				'component',
				'node',
				'controller',
				'page',
				'gear',
				'transition',
				'transition-item',
				'controller-action',
			],
		},
		packageId: text,
		componentId: text,
		resourceId: text,
		nodeId: text,
		controllerName: text,
		pageId: text,
		transitionName: text,
		index,
		selector: text,
		expectedMatches: index,
	},
	['kind'],
);
const scope: AuthoringJsonSchema = {
	oneOf: [
		{ const: 'base' },
		object({ controller: text, pageId: text }, ['controller', 'pageId']),
		object({ controller: text, allPages: { const: true } }, ['controller', 'allPages']),
	],
};
const props: AuthoringJsonSchema = {
	type: 'object',
	additionalProperties: true,
	description: 'Native property patch; omitted fields retain values, null clears optional fields, arrays replace.',
};
const shared = { target: AUTHORING_TARGET_SCHEMA };
const bindings = object(
	{
		nodes: { type: 'object', additionalProperties: { type: 'string' } },
		controllers: { type: 'object', additionalProperties: text },
		pages: { type: 'object', additionalProperties: text },
	},
	[],
);
const operation = (op: string, fields: Record<string, AuthoringJsonSchema>, required: string[] = []) =>
	object({ op: { const: op }, ...shared, ...fields }, ['op', 'target', ...required]);
export const AUTHORING_OPERATION_SCHEMA: AuthoringJsonSchema = {
	oneOf: [
		operation('create', { type: text, props, clientRef: text, toIndex: index }),
		operation('update', { props, scope }, ['props']),
		operation('remove', { cascade: { type: 'boolean' } }),
		operation('move', { destination: AUTHORING_TARGET_SCHEMA, toIndex: index, bindings }),
		operation('replace', { type: text, props, inboxPath: text }),
		operation('import', { inboxPath: text, props, clientRef: text }, ['inboxPath']),
		operation('clone', { destination: AUTHORING_TARGET_SCHEMA, props, clientRef: text, toIndex: index, bindings }),
		operation(
			'xml',
			{
				action: { enum: ['insert', 'attributes', 'replace'] },
				xml: { type: 'string', minLength: 1 },
				attributes: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
				bindings: { type: 'object', additionalProperties: text },
				index,
			},
			['action'],
		),
	],
};

function matches(schema: AuthoringJsonSchema, value: unknown, path: string): string | undefined {
	if (schema.oneOf) {
		const results = schema.oneOf.map((candidate) => matches(candidate, value, path));
		if (results.filter((item) => item === undefined).length === 1) return undefined;
		const selected = schema.oneOf.find(
			(candidate) => candidate.properties?.op?.const === (value as { op?: string } | null)?.op,
		);
		return selected ? (matches(selected, value, path) ?? path) : path;
	}
	if (Object.hasOwn(schema, 'const') && value !== schema.const) return path;
	if (schema.enum && !schema.enum.includes(value)) return path;
	if (schema.type) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
		if (!types.includes(actual) && !(actual === 'number' && types.includes('integer') && Number.isInteger(value)))
			return path;
	}
	if (
		typeof value === 'number' &&
		(!Number.isFinite(value) ||
			(schema.minimum !== undefined && value < schema.minimum) ||
			(schema.maximum !== undefined && value > schema.maximum))
	)
		return path;
	if (
		typeof value === 'string' &&
		((schema.minLength !== undefined && value.length < schema.minLength) ||
			(schema.maxLength !== undefined && value.length > schema.maxLength))
	)
		return path;
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return `${path}.${key}`;
		for (const [key, item] of Object.entries(value)) {
			const property = schema.properties?.[key];
			if (!property && schema.additionalProperties === false) return `${path}.${key}`;
			const child =
				property ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
			const error = child && matches(child, item, `${path}.${key}`);
			if (error) return error;
		}
	}
	if (Array.isArray(value) && schema.items)
		for (let i = 0; i < value.length; i++) {
			const error = matches(schema.items, value[i], `${path}[${i}]`);
			if (error) return error;
		}
	return undefined;
}
function jsonSafe(value: unknown, depth = 0): boolean {
	if (depth > 64) return false;
	if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item) => jsonSafe(item, depth + 1));
	return (
		typeof value === 'object' &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype &&
		Object.entries(value).every(
			([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && jsonSafe(item, depth + 1),
		)
	);
}

/**
 * Validates transport-independent operation envelopes against the exported schema.
 */
export function assertAuthoringOperations(value: unknown): void {
	if (!Array.isArray(value) || value.length < 1 || value.length > 200)
		throw new DocumentEditError('INVALID_EDIT', '编辑批次必须包含 1 至 200 项操作', 'operations');
	for (let i = 0; i < value.length; i++) {
		const operation = value[i];
		const path = `operations[${i}]`;
		const error = matches(AUTHORING_OPERATION_SCHEMA, operation, path);
		if (error || !jsonSafe(operation))
			throw new DocumentEditError('INVALID_EDIT', '编辑操作不符合字段契约', error ?? path, operation);
		for (const target of [operation.target, operation.destination].filter(Boolean)) {
			if (target.selector !== undefined && target.expectedMatches === undefined)
				throw new DocumentEditError('INVALID_EDIT', '选择器需要预期匹配数', `${path}.target.expectedMatches`);
		}
		if (
			operation.op === 'xml' &&
			(operation.action === 'attributes'
				? !operation.attributes || operation.xml !== undefined
				: !operation.xml || operation.attributes !== undefined)
		) {
			throw new DocumentEditError(
				'INVALID_EDIT',
				'XML 操作缺少匹配的内容',
				`${path}.${operation.action === 'attributes' ? 'attributes' : 'xml'}`,
			);
		}
	}
}

/**
 * Builds native property definitions from the same model surface used by editing.
 */
export function authoringPropertySchema(owner: Property): AuthoringJsonSchema {
	const properties: Record<string, AuthoringJsonSchema> = {};
	for (const [key, value] of Object.entries(readAuthoringProperties(owner))) {
		properties[key] =
			value === null
				? { type: ['null', 'string', 'number', 'boolean', 'object', 'array'] }
				: {
						type: ['name', 'text', 'settings'].includes(key)
							? Array.isArray(value)
								? 'array'
								: typeof value
							: [Array.isArray(value) ? 'array' : typeof value, 'null'],
					};
		Object.assign(properties[key]!, propertyConstraint(owner, key));
		if (['width', 'height'].includes(key)) properties[key]!.minimum = 0;
		if (key === 'alpha') Object.assign(properties[key]!, { minimum: 0, maximum: 1 });
		if (['x', 'y', 'width', 'height', 'pivotX', 'pivotY'].includes(key))
			properties[key]!.description = ['pivotX', 'pivotY'].includes(key)
				? 'Normalized pivot coordinate.'
				: 'Logical pixels.';
	}
	return object(properties, []);
}

function propertyConstraint(owner: Property, key: string): AuthoringJsonSchema {
	const numericEnums: Record<string, number> = {
		gearType: 9,
		easeType: 31,
		flip: 3,
		fillMethod: 5,
		fillOrigin: 3,
		overflow: 2,
		scrollType: 2,
		childrenRenderOrder: 2,
		align: 2,
		vAlign: 2,
	};
	if (key === 'actionType' && owner.propertyType === 'ControllerAction') return { enum: [0, 1, null] };
	if (key === 'actionType' && owner.propertyType === 'TransitionItem')
		return { enum: [...Array.from({ length: 16 }, (_, index) => index), null] };
	if (Object.hasOwn(numericEnums, key))
		return { enum: [...Array.from({ length: numericEnums[key]! + 1 }, (_, index) => index), null] };
	if (key === 'fps')
		return { type: ['integer', 'null'], minimum: 1, maximum: 240, description: 'Transition frames per second.' };
	if (owner.propertyType === 'TransitionItem' && ['time', 'duration'].includes(key))
		return { minimum: 0, description: 'Authoring frames, converted to seconds using the owning Transition fps.' };
	if (['tweenDuration', 'tweenDelay', 'autoPlayDelay'].includes(key)) return { minimum: 0, description: 'Seconds.' };
	if (['rotation', 'skewX', 'skewY'].includes(key)) return { description: 'Degrees.' };
	if (key === 'pageValues')
		return {
			type: ['object', 'null'],
			additionalProperties: { type: ['string', 'number', 'boolean', 'array', 'null'] },
			description:
				'Page ID to native tuple; arrays form comma-separated tuples. A null entry clears its override.',
		};
	if (key === 'relations')
		return {
			type: ['array', 'null'],
			items: object(
				{
					target: { type: 'string' },
					type: { type: 'integer', minimum: 0, maximum: 24 },
					usePercent: { type: 'boolean' },
				},
				['target', 'type', 'usePercent'],
			),
		};
	return {};
}

export function assertAuthoringPropertyValue(owner: Property, key: string, value: unknown): void {
	const error = matches(propertyConstraint(owner, key), value, `props.${key}`);
	if (error) throw new DocumentEditError('INVALID_PROPERTY', '属性值不符合原生枚举或范围', error, value);
}
