export { ProjectReader, type FileSystem, type ProjectReadOptions } from './io/project-reader.js';
export {
	ProjectWriter,
	type ProjectSourceFile,
	type ProjectWriteOptions,
} from './io/project-writer.js';
export {
	inspectProjectOutputConflicts,
	ProjectOutputConflictError,
	type ProjectOutputConflict,
	type ProjectOutputProducer,
} from './io/project-output-conflicts.js';
