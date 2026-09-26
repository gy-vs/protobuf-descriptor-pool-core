import { describe, expect, it } from 'vitest';
import {
  DescriptorPool,
  type Diagnostic,
  type FieldDescriptor,
  type FileDef,
  type FileDescriptor,
  type MessageDescriptor,
} from '../src/index.js';

const add = (pool: DescriptorPool, def: FileDef) => pool.addFile(def);

const diagCodes = (ds: Diagnostic[]) => ds.map((d) => d.code).sort();
const codesFor = (pool: DescriptorPool, file: string) =>
  diagCodes(pool.allDiagnostics().filter((d) => d.file === file));

describe('descriptor pool', () => {
  it('registers declarations before references and links files arriving out of order', () => {
    const pool = new DescriptorPool();

    // main.proto arrives first and references its missing dependency.
    const main = add(pool, {
      name: 'main.proto',
      package: 'main',
      dependency: ['dep.proto'],
      messageType: [
        {
          name: 'Top',
          field: [{ name: 'm', number: 1, typeName: 'dep.Msg' }],
        },
      ],
    });
    expect(main.state).toBe('pending');
    expect(pool.pendingFiles()).toEqual(['main.proto']);
    expect(codesFor(pool, 'main.proto')).toContain('missing-dependency');
    // Declarations are registered even while pending.
    expect(pool.symbolOwners('main.Top')).toEqual(['main.proto']);
    expect(pool.findMessage('main.Top')).toBeUndefined();

    add(pool, {
      name: 'dep.proto',
      package: 'dep',
      messageType: [{ name: 'Msg', field: [{ name: 'x', number: 1, type: 'int32' }] }],
    });

    expect(pool.getFileState('main.proto')).toBe('linked');
    expect(pool.pendingFiles()).toEqual([]);
    const top = pool.findMessage('main.Top')!;
    expect(top.fields[0].resolvedType?.fullName).toBe('dep.Msg');
  });

  it('resolves relative names through nested scopes with inner shadowing and reports the full lookup path', () => {
    const pool = new DescriptorPool();
    add(pool, {
      name: 'shadow.proto',
      package: 'p',
      messageType: [
        {
          name: 'Outer',
          nestedType: [
            { name: 'Foo', field: [{ name: 'a', number: 1, type: 'int32' }] },
            {
              name: 'Inner',
              nestedType: [{ name: 'Foo', field: [{ name: 'b', number: 1, type: 'int32' }] }],
              field: [{ name: 'f', number: 1, typeName: 'Foo' }],
            },
          ],
        },
      ],
    });

    const inner = pool.findMessage('p.Outer.Inner')!;
    expect(inner.fields[0].resolvedType?.fullName).toBe('p.Outer.Inner.Foo');

    // Complete lookup path, innermost lexical scope first.
    const r = pool.lookupType('shadow.proto', 'Foo', 'p.Outer.Inner');
    expect(r.lookupPath).toEqual(['p.Outer.Inner.Foo', 'p.Outer.Foo', 'p.Foo', 'Foo']);

    // From Outer scope the inner shadowing no longer applies.
    const r2 = pool.lookupType('shadow.proto', 'Foo', 'p.Outer');
    expect(r2.resolved?.fullName).toBe('p.Outer.Foo');
    expect(r2.lookupPath).toEqual(['p.Outer.Foo', 'p.Foo', 'Foo']);

    // Absolute leading-dot never walks lexical scopes: one candidate.
    const r3 = pool.lookupType('shadow.proto', '.p.Outer.Inner.Foo', 'p.Outer');
    expect(r3.resolved?.fullName).toBe('p.Outer.Inner.Foo');
    expect(r3.lookupPath).toEqual(['p.Outer.Inner.Foo']);

    // First component found but a later component missing is a hard error
    // anchored at the winning scope (no fallback to outer scopes).
    const pool2 = new DescriptorPool();
    add(pool2, {
      name: 'm.proto',
      package: 'p',
      messageType: [
        { name: 'Outer', nestedType: [{ name: 'Inner', field: [] }] },
      ],
    });
    const r4 = pool2.lookupType('m.proto', 'Inner.Missing', 'p.Outer');
    expect(r4.resolved).toBeUndefined();
    expect(r4.lookupPath).toEqual(['p.Outer.Inner.Missing', 'p.Inner.Missing', 'Inner.Missing']);
  });

  it('resolves across packages with import fallback, absolute names and import visibility', () => {
    const pool = new DescriptorPool();
    add(pool, { name: 'y.proto', package: 'y', messageType: [{ name: 'YMsg' }] });
    const x = add(pool, {
      name: 'x.proto',
      package: 'x',
      dependency: ['y.proto'],
      messageType: [
        {
          name: 'XMsg',
          field: [
            { name: 'rel', number: 1, typeName: 'y.YMsg' },
            { name: 'abs', number: 2, typeName: '.y.YMsg' },
          ],
        },
      ],
    });
    expect(x.state).toBe('linked');
    const xm = pool.findMessage('x.XMsg')!;
    expect(xm.fields[0].resolvedType?.fullName).toBe('y.YMsg');
    expect(xm.fields[1].resolvedType?.fullName).toBe('y.YMsg');
    expect(pool.lookupType('x.proto', 'y.YMsg').searchedImports).toContain('y.proto');

    // A symbol from a non-imported file is a hard visibility error.
    const pool2 = new DescriptorPool();
    add(pool2, { name: 'y.proto', package: 'y', messageType: [{ name: 'YMsg' }] });
    const z = add(pool2, {
      name: 'z.proto',
      package: 'z',
      messageType: [{ name: 'ZMsg', field: [{ name: 'q', number: 1, typeName: '.y.YMsg' }] }],
    });
    expect(z.state).toBe('error');
    const d = z.diagnostics.find((d) => d.code === 'not-imported')!;
    expect(d.owners).toEqual(['y.proto']);
  });

  it('makes import public transitively visible', () => {
    const pool = new DescriptorPool();
    add(pool, { name: 'b.proto', package: 'b', messageType: [{ name: 'BMsg' }] });
    // a.proto re-exports b.proto publicly.
    add(pool, {
      name: 'a.proto',
      package: 'a',
      dependency: ['b.proto'],
      publicDependency: [0],
    });
    const c = add(pool, {
      name: 'c.proto',
      package: 'c',
      dependency: ['a.proto'],
      messageType: [{ name: 'CMsg', field: [{ name: 'b', number: 1, typeName: 'b.BMsg' }] }],
    });
    expect(c.state).toBe('linked');
    expect(pool.findMessage('c.CMsg')!.fields[0].resolvedType?.fullName).toBe('b.BMsg');
  });

  it('tolerates missing weak imports with weak-unresolved warnings, then links when the file arrives', () => {
    const pool = new DescriptorPool();
    const w = add(pool, {
      name: 'w.proto',
      package: 'w',
      dependency: ['ghost.proto'],
      weakDependency: [0],
      messageType: [
        { name: 'Host', field: [{ name: 'g', number: 1, typeName: '.ghost.Guest' }] },
      ],
    });
    expect(w.state).toBe('linked');
    expect(codesFor(pool, 'w.proto')).toContain('weak-unresolved');
    expect(codesFor(pool, 'w.proto')).not.toContain('unresolved-type');
    const field = pool.findMessage('w.Host')!.fields[0];
    expect(field.resolvedType).toBeUndefined();
    expect(field.weakUnresolved).toBe(true);

    add(pool, { name: 'ghost.proto', package: 'ghost', messageType: [{ name: 'Guest' }] });
    expect(pool.getFileState('w.proto')).toBe('linked');
    const refreshed = pool.getFileDescriptor('w.proto')!.messages[0].fields[0];
    expect(refreshed.resolvedType?.fullName).toBe('ghost.Guest');
    expect(refreshed.weakUnresolved).toBeUndefined();
    expect(codesFor(pool, 'w.proto')).not.toContain('weak-unresolved');
  });

  it('does not mask genuine typos as weak failures', () => {
    const pool = new DescriptorPool();
    const w = add(pool, {
      name: 'w.proto',
      package: 'w',
      dependency: ['ghost.proto'],
      weakDependency: [0],
      messageType: [
        // Head component exists in this file; the missing member is a real error.
        {
          name: 'Host',
          nestedType: [{ name: 'Inner' }],
          field: [{ name: 'g', number: 1, typeName: 'Inner.Nope' }],
        },
      ],
    });
    expect(w.state).toBe('error');
    expect(codesFor(pool, 'w.proto')).toContain('unresolved-type');
    expect(codesFor(pool, 'w.proto')).not.toContain('weak-unresolved');
  });

  it('allows a field and a type with the same name (separate namespaces)', () => {
    const pool = new DescriptorPool();
    const r = add(pool, {
      name: 'same.proto',
      package: 'p',
      messageType: [
        {
          name: 'M',
          enumType: [{ name: 'Status', value: [{ name: 'UNKNOWN', number: 0 }] }],
          field: [{ name: 'Status', number: 1, type: 'int32' }],
        },
      ],
    });
    expect(r.state).toBe('linked');
    const m = pool.findMessage('p.M')!;
    expect(m.fields[0].name).toBe('Status');
    expect(m.nestedEnums[0].fullName).toBe('p.M.Status');
  });

  it('treats identical re-add as idempotent and different content as an incremental revision', () => {
    const pool = new DescriptorPool();
    const def: FileDef = {
      name: 'rev.proto',
      package: 'r',
      messageType: [{ name: 'V1', field: [{ name: 'a', number: 1, type: 'int32' }] }],
    };
    const first = add(pool, def);
    expect(first.revision).toBe(1);

    const again = add(pool, structuredClone(def));
    expect(again.identical).toBe(true);
    expect(again.revision).toBe(1);
    const v1 = pool.findMessage('r.V1');
    expect(pool.findMessage('r.V1')).toBe(v1);

    // A dependent holds the published descriptor.
    add(pool, {
      name: 'user.proto',
      package: 'u',
      dependency: ['rev.proto'],
      messageType: [{ name: 'U', field: [{ name: 'v', number: 1, typeName: '.r.V1' }] }],
    });
    const oldFile = pool.getFileDescriptor('rev.proto')!;
    const oldU = pool.getFileDescriptor('user.proto')!;
    expect(Object.isFrozen(oldFile)).toBe(true);
    expect(Object.isFrozen(v1)).toBe(true);

    const replaced = add(pool, {
      name: 'rev.proto',
      package: 'r',
      messageType: [
        { name: 'V1', field: [{ name: 'a', number: 1, type: 'int64' }] },
        { name: 'V2' },
      ],
    });
    expect(replaced.identical).toBe(false);
    expect(replaced.revision).toBe(2);

    // Old publication stays immutable even though lookup moved on.
    expect(Object.isFrozen(oldFile)).toBe(true);
    expect(() => {
      (oldFile as unknown as { package: string }).package = 'hacked';
    }).toThrow();

    const newFile = pool.getFileDescriptor('rev.proto')!;
    expect(newFile).not.toBe(oldFile);
    expect(newFile.revision).toBe(2);
    expect(pool.findMessage('r.V2')).toBeDefined();
    // Dependent was re-linked with fresh identity.
    expect(pool.getFileDescriptor('user.proto')).not.toBe(oldU);
    expect(pool.findMessage('u.U')!.fields[0].resolvedType?.fullName).toBe('r.V1');
  });

  it('links import cycles and emits canonical cycle warnings independent of arrival order', () => {
    const build = (order: [FileDef, FileDef]) => {
      const pool = new DescriptorPool();
      for (const f of order) add(pool, f);
      return pool;
    };
    const c1: FileDef = {
      name: 'c1.proto',
      package: 'c',
      dependency: ['c2.proto'],
      messageType: [{ name: 'M1', field: [{ name: 'm2', number: 1, typeName: '.c.M2' }] }],
    };
    const c2: FileDef = {
      name: 'c2.proto',
      package: 'c',
      dependency: ['c1.proto'],
      messageType: [{ name: 'M2', field: [{ name: 'm1', number: 1, typeName: '.c.M1' }] }],
    };

    for (const order of [[c1, c2], [c2, c1]] as [FileDef, FileDef][]) {
      const pool = build(order);
      expect(pool.getFileState('c1.proto')).toBe('linked');
      expect(pool.getFileState('c2.proto')).toBe('linked');
      expect(pool.findMessage('c.M1')!.fields[0].resolvedType?.fullName).toBe('c.M2');
      expect(pool.findMessage('c.M2')!.fields[0].resolvedType?.fullName).toBe('c.M1');
      const cycle = pool.allDiagnostics().find((d) => d.code === 'import-cycle')!;
      expect(cycle.cycle).toEqual(['c1.proto', 'c2.proto']);
    }
  });

  it('reports duplicate symbols symmetrically regardless of load order, and recovers on revision', () => {
    const f1: FileDef = {
      name: 'd1.proto',
      package: 'q',
      messageType: [{ name: 'X' }],
    };
    const f2: FileDef = {
      name: 'd2.proto',
      package: 'q',
      messageType: [{ name: 'X' }],
    };

    for (const order of [[f1, f2], [f2, f1]] as [FileDef, FileDef][]) {
      const pool = new DescriptorPool();
      for (const f of order) add(pool, f);
      expect(pool.errorFiles().sort()).toEqual(['d1.proto', 'd2.proto']);
      for (const file of ['d1.proto', 'd2.proto']) {
        const d = pool.allDiagnostics().find((x) => x.file === file && x.code === 'duplicate-symbol')!;
        expect(d.owners).toEqual(['d1.proto', 'd2.proto']);
        expect(d.symbol).toBe('q.X');
      }
    }

    // First file alone links; peer arrival invalidates it; peer revision
    // removing the conflict heals the first file again.
    const pool = new DescriptorPool();
    add(pool, f1);
    expect(pool.getFileState('d1.proto')).toBe('linked');
    add(pool, f2);
    expect(pool.getFileState('d1.proto')).toBe('error');
    add(pool, { name: 'd2.proto', package: 'q', messageType: [{ name: 'Y' }] });
    expect(pool.getFileState('d1.proto')).toBe('linked');
    expect(pool.getFileState('d2.proto')).toBe('linked');
    expect(pool.findMessage('q.X')).toBeDefined();
    expect(pool.findMessage('q.Y')).toBeDefined();
  });

  it('flags same-FQN declarations of different kinds as ambiguous', () => {
    const pool = new DescriptorPool();
    add(pool, { name: 'k1.proto', package: 'k', messageType: [{ name: 'K' }] });
    add(pool, {
      name: 'k2.proto',
      package: 'k',
      enumType: [{ name: 'K', value: [{ name: 'ZERO', number: 0 }] }],
    });
    expect(pool.errorFiles().sort()).toEqual(['k1.proto', 'k2.proto']);
    expect(
      pool.allDiagnostics().filter((d) => d.code === 'ambiguous-symbol'),
    ).toHaveLength(2);
  });

  it('indexes nested messages, enum values, services and extensions by FQN', () => {
    const pool = new DescriptorPool();
    add(pool, {
      name: 'idx.proto',
      package: 'p',
      messageType: [
        {
          name: 'Outer',
          nestedType: [{ name: 'Inner' }],
          enumType: [{ name: 'E', value: [{ name: 'A', number: 0 }, { name: 'B', number: 1 }] }],
          extension: [
            { name: 'tag', number: 100, extendee: '.p.Outer', type: 'int32' },
          ],
        },
      ],
      enumType: [{ name: 'TopE', value: [{ name: 'V', number: 0 }] }],
      extension: [{ name: 'global_tag', number: 101, extendee: '.p.Outer', type: 'string' }],
      service: [
        {
          name: 'Svc',
          method: [
            { name: 'Call', inputType: '.p.Outer', outputType: '.p.Outer.Inner' },
          ],
        },
      ],
    });

    expect(pool.findMessage('p.Outer.Inner')).toBeDefined();
    expect(pool.findEnum('p.Outer.E')).toBeDefined();
    expect((pool.findSymbol('p.Outer.E.A') as { number: number }).number).toBe(0);
    expect(pool.findSymbol('p.TopE.V')).toBeDefined();
    expect(pool.findService('p.Svc')).toBeDefined();

    const svc = pool.findService('p.Svc')!;
    expect(svc.methods[0].resolvedInput?.fullName).toBe('p.Outer');
    expect(svc.methods[0].resolvedOutput?.fullName).toBe('p.Outer.Inner');

    const ext = pool.findSymbol('p.Outer.tag') as { extendee?: string; resolvedExtendee?: { fullName: string } };
    expect(ext.resolvedExtendee.fullName).toBe('p.Outer');
    const fileExt = pool.findSymbol('p.global_tag') as { kind: string };
    expect(fileExt.kind).toBe('extension');
  });

  it('propagates strong dependency errors, but downgrades weak-only references', () => {
    const broken: FileDef = {
      name: 'broken.proto',
      package: 'b',
      messageType: [{ name: 'B', field: [{ name: 'x', number: 1, typeName: '.nope.Missing' }] }],
    };

    const pool = new DescriptorPool();
    add(pool, broken);
    add(pool, {
      name: 'strong.proto',
      package: 's',
      dependency: ['broken.proto'],
      messageType: [{ name: 'S', field: [{ name: 'b', number: 1, typeName: '.b.B' }] }],
    });
    add(pool, {
      name: 'weak-user.proto',
      package: 'wu',
      dependency: ['broken.proto'],
      weakDependency: [0],
      messageType: [{ name: 'W', field: [{ name: 'b', number: 1, typeName: '.b.B' }] }],
    });

    expect(pool.errorFiles().sort()).toEqual(['broken.proto', 'strong.proto']);
    expect(pool.getFileState('weak-user.proto')).toBe('linked');
    const wf = pool.findMessage('wu.W')!.fields[0];
    expect(wf.resolvedType).toBeUndefined();
    expect(wf.weakUnresolved).toBe(true);
    expect(codesFor(pool, 'strong.proto')).toContain('dependency-error');
  });

  it('produces identical final results for every file arrival permutation', () => {
    const files: FileDef[] = [
      {
        name: 'base.proto',
        package: 'base',
        messageType: [
          {
            name: 'Base',
            nestedType: [{ name: 'Nested' }],
            enumType: [{ name: 'Kind', value: [{ name: 'K0', number: 0 }, { name: 'K1', number: 1 }] }],
            field: [
              { name: 'self', number: 1, typeName: 'Nested' },
              { name: 'k', number: 2, typeName: 'Kind' },
            ],
          },
        ],
      },
      {
        name: 'public_mid.proto',
        package: 'mid',
        dependency: ['base.proto'],
        publicDependency: [0],
        messageType: [{ name: 'Mid', field: [{ name: 'b', number: 1, typeName: '.base.Base' }] }],
      },
      {
        name: 'app.proto',
        package: 'app',
        dependency: ['public_mid.proto', 'base.proto'],
        publicDependency: [0],
        messageType: [
          {
            name: 'App',
            field: [
              { name: 'm', number: 1, typeName: 'mid.Mid' },
              { name: 'nested', number: 2, typeName: 'base.Base.Nested' },
            ],
          },
        ],
        service: [{ name: 'Svc', method: [{ name: 'Ping', inputType: '.app.App', outputType: '.base.Base' }] }],
      },
      {
        name: 'cyclic.proto',
        package: 'cyc',
        dependency: ['app.proto'],
        messageType: [{ name: 'C', field: [{ name: 'a', number: 1, typeName: '.app.App' }] }],
      },
    ];
    // app -> cyclic back edge (makes a cycle)
    files[2].dependency!.push('cyclic.proto');

    const snapshot = (order: FileDef[]) => {
      const pool = new DescriptorPool();
      for (const f of order) add(pool, f);
      const states: Record<string, string> = {};
      const descriptors: Record<string, unknown> = {};
      for (const name of Object.keys(Object.fromEntries(files.map((f) => [f.name, true]))).sort()) {
        states[name] = pool.getFileState(name)!;
        descriptors[name] = normalizeDescriptor(pool.getFileDescriptor(name));
      }
      return { states, descriptors, diagnostics: normalizeDiagnostics(pool.allDiagnostics()) };
    };

    const reference = snapshot(files);
    const permutations = permute(files);
    expect(permutations).toHaveLength(24);
    for (const order of permutations) {
      expect(snapshot(order)).toEqual(reference);
    }
  });

  it('handles missing strong dependencies with pending diagnostics and links them incrementally', () => {
    const pool = new DescriptorPool();
    const a = add(pool, {
      name: 'a.proto',
      dependency: ['b.proto', 'c.proto'],
      messageType: [],
    });
    expect(a.state).toBe('pending');
    const md = a.diagnostics.filter((d) => d.code === 'missing-dependency');
    expect(md.map((d) => d.symbol).sort()).toEqual(['b.proto', 'c.proto']);

    add(pool, { name: 'b.proto' });
    expect(pool.getFileState('a.proto')).toBe('pending');

    add(pool, { name: 'c.proto' });
    expect(pool.getFileState('a.proto')).toBe('linked');
  });

  it('links a pending chain when the leaf dependency arrives transitive', () => {
    const pool = new DescriptorPool();
    add(pool, {
      name: 'app.proto',
      package: 'app',
      dependency: ['mid.proto'],
      messageType: [{ name: 'A', field: [{ name: 'm', number: 1, typeName: '.mid.M' }] }],
    });
    add(pool, {
      name: 'mid.proto',
      package: 'mid',
      dependency: ['leaf.proto'],
      messageType: [{ name: 'M', field: [{ name: 'l', number: 1, typeName: '.leaf.L' }] }],
    });
    expect(pool.getFileState('app.proto')).toBe('pending');

    add(pool, { name: 'leaf.proto', package: 'leaf', messageType: [{ name: 'L' }] });
    expect(pool.linkedFiles().sort()).toEqual(['app.proto', 'leaf.proto', 'mid.proto']);
    expect(pool.findMessage('app.A')!.fields[0].resolvedType?.fullName).toBe('mid.M');
    expect(pool.findMessage('mid.M')!.fields[0].resolvedType?.fullName).toBe('leaf.L');
  });

  it('registers enum values as siblings of the enum, not a lexical scope', () => {
    const pool = new DescriptorPool();
    add(pool, {
      name: 'ev.proto',
      package: 'p',
      messageType: [
        {
          name: 'Msg',
          enumType: [{ name: 'Kind', value: [{ name: 'ZERO', number: 0 }, { name: 'ONE', number: 1 }] }],
          // Field types live in the type namespace: 'Kind' resolves; 'ONE' is
          // an enum value sibling, not a type.
          field: [
            { name: 'k', number: 1, typeName: 'Kind' },
            { name: 'v', number: 2, type: 'string' },
          ],
        },
      ],
    });
    expect(pool.getFileState('ev.proto')).toBe('linked');
    const msg = pool.findMessage('p.Msg')!;
    expect(msg.fields[0].resolvedType?.fullName).toBe('p.Msg.Kind');
    expect(pool.findSymbol('p.Msg.Kind.ZERO')).toBeDefined();
    expect(pool.findSymbol('p.Msg.Kind.ONE')).toBeDefined();
  });

  it('resolves normally when a declared weak import is present', () => {
    const pool = new DescriptorPool();
    add(pool, { name: 'opt.proto', package: 'o', messageType: [{ name: 'Opt' }] });
    const r = add(pool, {
      name: 'user.proto',
      package: 'u',
      dependency: ['opt.proto'],
      weakDependency: [0],
      messageType: [{ name: 'U', field: [{ name: 'o', number: 1, typeName: '.o.Opt' }] }],
    });
    expect(r.state).toBe('linked');
    expect(pool.findMessage('u.U')!.fields[0].resolvedType?.fullName).toBe('o.Opt');
    expect(codesFor(pool, 'user.proto')).toEqual([]);
  });

  it('reports a full single-candidate lookup path for an unresolved absolute name', () => {
    const pool = new DescriptorPool();
    const r = pool.lookupType(
      add(pool, { name: 'f.proto', package: 'p', messageType: [{ name: 'M' }] }).name,
      '.p.Gone',
      'p.M',
    );
    expect(r.resolved).toBeUndefined();
    expect(r.lookupPath).toEqual(['p.Gone']);
  });

  it('reports not-imported for relative references resolvable only via a hidden file', () => {
    const pool = new DescriptorPool();
    add(pool, { name: 'other.proto', package: 'x', messageType: [{ name: 'X' }] });
    const r = add(pool, {
      name: 'use.proto',
      package: 'u',
      messageType: [{ name: 'U', field: [{ name: 'q', number: 1, typeName: 'x.X' }] }],
    });
    expect(r.state).toBe('error');
    const d = r.diagnostics.find((d) => d.code === 'not-imported')!;
    expect(d.owners).toEqual(['other.proto']);
    expect(d.lookupPath).toContain('x.X');
  });

  it('does not share declarations across revisions of the same file', () => {    const pool = new DescriptorPool();
    add(pool, { name: 'v.proto', package: 'p', messageType: [{ name: 'Old' }] });
    expect(pool.findSymbol('p.Old')).toBeDefined();
    add(pool, { name: 'v.proto', package: 'p', messageType: [{ name: 'New' }] });
    expect(pool.findSymbol('p.Old')).toBeUndefined();
    expect(pool.findSymbol('p.New')).toBeDefined();
    expect(pool.symbolOwners('p.New')).toEqual(['v.proto']);
    expect(pool.getRevision('v.proto')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Snapshot helpers: resolve descriptor pointers to names so the graph compares
// structurally across pools.
// ---------------------------------------------------------------------------

function normalizeDescriptor(fd: FileDescriptor | undefined): unknown {
  if (!fd) return null;
  const field = (f: FieldDescriptor) => ({
    name: f.name,
    number: f.number,
    type: f.resolvedType?.fullName ?? null,
    extendee: f.resolvedExtendee?.fullName ?? null,
    weakUnresolved: !!f.weakUnresolved,
  });
  const message = (m: MessageDescriptor): unknown => ({
    kind: m.kind,
    name: m.name,
    fullName: m.fullName,
    fields: m.fields.map(field),
    extensions: m.extensions.map(field),
    nested: m.nestedMessages.map((n) => message(n)),
    enums: m.nestedEnums.map((e) => e.fullName),
  });
  return {
    name: fd.name,
    package: fd.package,
    revision: fd.revision,
    dependencies: fd.dependencies,
    messages: fd.messages.map((m) => message(m)),
    enums: fd.enums.map((e) => e.fullName),
    extensions: fd.extensions.map(field),
    services: fd.services.map((s) => ({
      name: s.fullName,
      methods: s.methods.map((m) => ({
        name: m.name,
        in: m.resolvedInput?.fullName ?? null,
        out: m.resolvedOutput?.fullName ?? null,
        weak: m.weakUnresolved.slice().sort(),
      })),
    })),
  };
}

function normalizeDiagnostics(ds: Diagnostic[]): unknown {
  return ds
    .filter((d) => d.code !== 'import-cycle' || d.file === ds.filter((x) => x.code === 'import-cycle').sort((a, b) => (a.file ?? '').localeCompare(b.file ?? ''))[0]?.file)
    .map((d) => ({
      code: d.code,
      severity: d.severity,
      file: d.file,
      symbol: d.symbol,
      owners: d.owners,
      lookupPath: d.lookupPath,
      searchedImports: d.searchedImports,
      cycle: d.cycle,
    }));
}

function permute<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = permute([...items.slice(0, i), ...items.slice(i + 1)]);
    for (const r of rest) out.push([items[i], ...r]);
  }
  return out;
}
