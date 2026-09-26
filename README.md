# Protocol Buffers core

TypeScript library for wire format processing and descriptor pools.

## Descriptor pool

`DescriptorPool` registers `.proto` files (as `FileNode` ASTs) in any order,
resolves fully-qualified symbols across packages, nested messages, enums,
services and extensions, and publishes immutable `FileDescriptor` graphs.

The two phases are strictly separated:

1. **Declaration** (`addFile` time): package/message/enum/enum-value/
   service/method/field/extension symbols are registered in a pool-wide
   symbol table. Duplicate symbols and import cycles are reported here,
   even while dependencies are still missing.
2. **Linking** (incremental, automatic): once every non-weak dependency of
   a file is linked, the file's type references are resolved (C++ scoping
   rules: innermost scope first, first-component shadowing, leading dot =
   fully qualified), import visibility is checked (direct + transitive
   `public` imports; `weak` imports may be absent), and a frozen
   `FileDescriptor` is published. Linking one file cascades to everything
   that was waiting on it.

Semantics:

- Files may arrive out of order; missing dependencies keep a file `pending`
  and the final pool state does not depend on arrival order.
- A missing `weak` import never blocks linking and is recorded on the file
  (`missingWeakDependenciesOf`).
- Re-adding identical contents is a no-op; different contents under the same
  name throw `DuplicateFileError`. `replaceFile` swaps a **pending** file for
  a new revision and re-links dependents; published files are immutable and
  cannot be replaced.
- Unresolvable names throw `SymbolLookupError` carrying the complete
  `searchPath` of every fully-qualified candidate tried.
- Published descriptors are frozen: mutators throw `FrozenDescriptorError`.

```ts
import { DescriptorPool, fileNode, messageNode, fieldNode } from 'protobuf-descriptor-pool-core';

const pool = new DescriptorPool();
pool.addFile(fileNode('app.proto', {
  package: 'app',
  dependencies: ['common.proto'],
  messages: [messageNode('App', { fields: [fieldNode('ts', 1, 'common.Timestamp')] })],
})); // => null (pending: common.proto not loaded yet)

pool.addFile(fileNode('common.proto', {
  package: 'common',
  messages: [messageNode('Timestamp')],
})); // links common.proto, then app.proto cascades

pool.findMessageTypeByName('app.App'); // immutable MessageDescriptor
```

Run `npm install`, then `npm test` and `npm run build`.
