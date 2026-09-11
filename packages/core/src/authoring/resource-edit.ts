import type { Document } from '../document.js';
import type { Package } from '../properties/package.js';
import type { Component } from '../properties/component.js';
import { generateResourceId } from '../utils/id-utils.js';
import { readImageSize } from '../io/project-reader.js';
import { projectResourceFileName } from '../io/project-output-conflicts.js';
import { DocumentEditError, setAuthoringProperties } from './document-edit.js';

type Resource = ReturnType<Package['listResources']>[number];
type BinaryResource = Exclude<Resource, Component>;
export interface AuthoringImportData {
	fileName: string;
	data: Uint8Array;
}
export function assertAuthoringName(name: string): void {
	if (
		!name ||
		/[\u0000-\u001f<>:"/\\|?*]/u.test(name) ||
		/[. ]$/.test(name) ||
		/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
	)
		throw new DocumentEditError('INVALID_SOURCE_PATH', '资源名称不是有效文件名', 'props.name', name);
}
export function assertAuthoringResourcePath(value: string): void {
	if (!/^\/(?:[^\\/:]+\/)*$/.test(value) || value.split('/').some((segment) => segment === '.' || segment === '..'))
		throw new DocumentEditError('INVALID_SOURCE_PATH', '资源路径需要规范的绝对包内目录', 'props.path', value);
	for (const segment of value.split('/').filter(Boolean)) assertAuthoringName(segment);
}
export function setAuthoringResourceFile(resource: Resource, fileName: string): void {
	assertAuthoringName(fileName);
	const owner = resource as unknown as { setFileName?: (value: string) => void; setFile?: (value: string) => void };
	if (owner.setFileName) owner.setFileName(fileName);
	else if (owner.setFile) owner.setFile(fileName);
	else throw new DocumentEditError('INVALID_PROPERTY', '目标类型没有二进制源文件');
}
export function renameAuthoringResource(resource: Resource, name: string): void {
	assertAuthoringName(name);
	if (resource.propertyType !== 'Component') {
		const previous = projectResourceFileName(resource);
		const extension = previous.lastIndexOf('.') > 0 ? previous.slice(previous.lastIndexOf('.')) : '';
		setAuthoringResourceFile(resource, `${name}${extension}`);
	}
	resource.setName(name);
}
export function applyResourceImport(
	document: Document,
	pkg: Package,
	input: AuthoringImportData,
	props: Record<string, unknown>,
	existing?: Resource,
): Resource {
	assertAuthoringName(input.fileName);
	const extension = input.fileName.lastIndexOf('.') > 0 ? input.fileName.slice(input.fileName.lastIndexOf('.')) : '';
	const kind = /\.(png|jpg|jpeg|webp|svg)$/i.test(extension)
		? 'ImageResource'
		: /\.(mp3|wav|ogg)$/i.test(extension)
			? 'SoundResource'
			: /\.(fnt|ttf|otf|woff2?)$/i.test(extension)
				? 'FontResource'
				: extension.toLowerCase() === '.jta'
					? 'MovieClipResource'
					: 'MiscResource';
	if (existing && existing.propertyType !== kind)
		throw new DocumentEditError('INVALID_PROPERTY', '替换文件类型与现有资源不兼容', 'inboxPath', {
			expected: existing.propertyType,
			actual: kind,
		});
	const name = String(
		props.name ?? existing?.getName() ?? (extension ? input.fileName.slice(0, -extension.length) : input.fileName),
	);
	const directory = String(props.path ?? existing?.getPath() ?? '/');
	assertAuthoringName(name);
	assertAuthoringResourcePath(directory);
	if (
		pkg
			.listResources()
			.some(
				(item) =>
					item !== existing &&
					item.getName().toLowerCase() === name.toLowerCase() &&
					(item.getPath() || '/').toLowerCase() === directory.toLowerCase(),
			)
	)
		throw new DocumentEditError('RESOURCE_CONFLICT', '目标目录已有同名资源', 'props.name', name);
	const factory = (document as unknown as Record<string, (name: string) => Resource>)[`create${kind}`]!;
	const resource = (existing ??
		factory
			.call(document, name)
			.setId(generateResourceId(pkg.listResources().map((item) => item.getId())))) as BinaryResource;
	setAuthoringProperties(resource, { ...props, name, path: directory });
	setAuthoringResourceFile(resource, `${name}${extension}`);
	if (kind === 'ImageResource') {
		const size = readImageSize(input.data);
		if (!size) throw new DocumentEditError('INVALID_PROPERTY', '图片源文件缺少可识别的有效尺寸', 'inboxPath');
		setAuthoringProperties(resource, size);
	}
	const buffer = document.createBuffer().setData(new Uint8Array(input.data));
	resource.setSourceData(buffer);
	if (!existing) pkg.addResource(resource);
	return resource;
}
