# @magicskysword/openfairygui-functions

Composable authoring and publish functions built on top of `@magicskysword/openfairygui-core`.

## Install

```bash
npm install --save @magicskysword/openfairygui-core @magicskysword/openfairygui-functions
```

## Usage

```ts
import { NodeIO } from '@magicskysword/openfairygui-core';
import { inspect, publish } from '@magicskysword/openfairygui-functions';

const io = new NodeIO();
const doc = await io.readProject('./MyProject/MyProject.fairy');

const report = inspect(doc);
await doc.transform(publish({ output: './release' }));
```

Repository:

- https://github.com/OpenFairyGUI/OpenFairyGUI
