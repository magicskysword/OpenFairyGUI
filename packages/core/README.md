# @magicskysword/openfairygui-core

Core SDK for OpenFairyGUI, providing the document model, property graph, project I/O, and binary I/O.

## Install

```bash
npm install --save @magicskysword/openfairygui-core
```

## Usage

Browser-safe root entry:

```ts
import { Document } from '@magicskysword/openfairygui-core';
```

Node project I/O:

```ts
import { NodeIO } from '@magicskysword/openfairygui-core/node';

const io = new NodeIO();
const doc = await io.readProject('./MyProject/MyProject.fairy');
```

Browser project I/O:

```ts
import { WebIO } from '@magicskysword/openfairygui-core/web';

const io = new WebIO({ root: projectDirectoryHandle });
const doc = await io.readProject('Project.fairy');
```

Shared project I/O types without platform adapters:

```ts
import { ProjectReader, ProjectWriter, type FileSystem } from '@magicskysword/openfairygui-core/project-io';
```

`@magicskysword/openfairygui-core/web` only reads and writes FairyGUI project trees. Publishing, restoring, and Node filesystem defaults stay outside the browser entrypoint.

See the repository README for broader examples and workflow guidance:

- https://github.com/magicskysword/OpenFairyGUI
