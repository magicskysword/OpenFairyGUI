import type { ProjectSnapshot } from './project-snapshot.js';
import { publishToMemory, type PublishToMemoryOptions } from './publish-memory.js';

export interface PreviewArtifact {
	fileName: string;
	mediaType: string;
	data: Uint8Array;
}
export interface PreviewArtifacts {
	snapshotFingerprint: string;
	packages: Array<{ packageId: string; packageName: string; fileName: string }>;
	artifacts: PreviewArtifact[];
}
function mediaType(file: string): string {
	const extension = file.split('.').pop()?.toLowerCase() ?? '';
	return (
		(
			{
				png: 'image/png',
				jpg: 'image/jpeg',
				jpeg: 'image/jpeg',
				webp: 'image/webp',
				json: 'application/json',
				mp3: 'audio/mpeg',
				wav: 'audio/wav',
				ogg: 'audio/ogg',
			} as Record<string, string>
		)[extension] ?? 'application/octet-stream'
	);
}

/**
 * Builds immutable runtime packages using only captured source bytes.
 */
export async function buildPreviewArtifacts(
	snapshot: ProjectSnapshot,
	options: Pick<PublishToMemoryOptions, 'encoder'> = {},
): Promise<PreviewArtifacts> {
	const document = await snapshot.readDocument();
	const sources = document.getRoot().listPackages();
	for (const pkg of sources) for (const component of pkg.listComponents()) component.setExported(true);
	const settings = document.getRoot().getSettings();
	document.getRoot().setSettings({ ...settings, publish: { ...settings.publish, includeHighResolution: 7 } });
	const fs = snapshot.fileSystem();
	const artifacts = await publishToMemory(document, {
		...options,
		basePath: fs.join(fs.dirname(snapshot.projectPath), 'assets'),
		fileExtension: 'fui',
		atlas: { readFileRaw: (file) => fs.readFileRaw(file) },
	});
	const packages = sources.map((pkg) => ({
		packageId: pkg.getId(),
		packageName: pkg.getName(),
		fileName: `${pkg.getPublishName() || pkg.getName()}.fui`,
	}));
	for (const pkg of packages)
		if (!artifacts.some((file) => file.fileName === pkg.fileName))
			throw new Error(`运行时包未生成：${pkg.packageId}/${pkg.packageName}`);
	return {
		snapshotFingerprint: snapshot.fingerprint,
		packages,
		artifacts: artifacts.map((file) => ({ ...file, mediaType: mediaType(file.fileName) })),
	};
}
