export { PlatformIO } from './platform-io.js';
export { ProjectReader, type FileSystem, type ProjectReadOptions } from './project-reader.js';
export {
	ProjectWriter,
	ProjectOutputConflictError,
	type ProjectOutputProducer,
	type ProjectSourceFile,
	type ProjectWriteOptions,
} from './project-writer.js';
export { BinaryReader } from './binary-reader.js';
export { BinaryWriter, type BinaryWriterOptions } from './binary-writer.js';
export {
	inferHighResolutionItemIds,
	type HighResolutionResourceLike,
} from './high-resolution-resources.js';
export { ReaderContext } from './reader-context.js';
export {
	preserveOpaqueProjectXml,
	inspectOpaqueProjectXml,
	type OpaqueProjectXmlKind,
	type OpaqueXmlFinding,
} from './opaque-project-xml.js';
export {
	serializeProjectFiles,
	serializeAffectedProjectFiles,
	type SerializedProjectFile,
	type SerializedProjectFileKind,
	type ProjectFileTarget,
} from './project-files.js';
