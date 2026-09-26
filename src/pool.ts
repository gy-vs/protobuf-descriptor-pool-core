/**
 * Descriptor pool.
 *
 * Two phases are kept strictly separate:
 *
 *   1. Declaration registration. A file arriving in any order has its package,
 *      messages, enums, services, extensions and enum values entered into the
 *      global symbol table. No references are inspected.
 *
 *   2. Reference linking. After every registration (or revision replacement)
 *      the pool incrementally (re)links exactly the affected files. Files
 *      whose strong dependencies are absent stay `pending`; supplying the
 *      missing file unblocks and links the waiting dependents automatically.
 *
 * Semantics:
 *   - `import public` is a strong dependency whose symbols are transitively
 *     visible through it.
 *   - `import weak` never blocks linking while the file is absent; references
 *     that cannot be resolved in its presence downgrade to weak-unresolved
 *     warnings.
 *   - Relative type names follow proto/C++ lexical scoping: the enclosing
 *     message chain, the package scope, the global root, then an imported
 *     package fallback. Unresolved diagnostics carry the complete lookup
 *     path and the imported files searched.
 *   - Duplicate fully qualified symbols produce symmetric, order-independent
 *     duplicate-symbol / ambiguous-symbol errors; peer owners are re-linked
 *     when conflicts appear or disappear.
 *   - Import cycles among present files link (declarations always precede
 *     linking); a canonical, order-independent cycle chain is warned.
 *   - Replacing a file with different content bumps a revision; the old
 *     publication stays frozen and exactly the affected set re-links.
 */

import {
  type AddFileResult,
  type Diagnostic,
  type DiagnosticCode,
  type EnumDescriptor,
  type EnumValueDescriptor,
  type FieldDescriptor,
  type FieldDef,
  type FileDef,
  type FileDependencyDescriptor,
  type FileDescriptor,
  type FileState,
  type MessageDef,
  type MessageDescriptor,
  type MethodDescriptor,
  type ServiceDescriptor,
} from './descriptor.js';

type SymbolKind = 'message' | 'enum' | 'service' | 'extension' | 'enum-value' | 'package';
type TypeKind = 'message' | 'enum' | 'service';

interface SymbolEntry {
  fullName: string;
  kind: SymbolKind;
  file: string;
  scope: string;
}

interface FileRecord {
  name: string;
  def: FileDef;
  revision: number;
  /** Dependency edges, classified/de-duplicated, sorted by file name. */
  edges: FileDependencyDescriptor[];
  /** FQNs this revision declares (used to retract publications). */
  declared: Set<string>;
  state: FileState;
  diagnostics: Diagnostic[];
  /** Published descriptor; stable identity until the file is invalidated. */
  descriptor?: FileDescriptor;
}

interface ResolveResult {
  target?: unknown;
  kind?: SymbolKind | 'scalar';
  lookupPath: string[];
  searchedImports: string[];
  diagnostic?: Diagnostic;
}

const PRIMITIVES = new Set([
  'double', 'float', 'int64', 'uint64', 'int32', 'fixed64', 'fixed32',
  'bool', 'string', 'bytes', 'uint32', 'sfixed32', 'sfixed64', 'sint32',
  'sint64',
]);

export class DescriptorPool {
  private files = new Map<string, FileRecord>();
  /** FQN -> all declarations (packages may have many owners). */
  private symbols = new Map<string, SymbolEntry[]>();
  /** FQN -> published frozen descriptor. */
  private published = new Map<string, unknown>();

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Register a file's declarations, then incrementally link. Identical
   * content is a no-op; different content installs a new revision.
   */
  addFile(def: FileDef): AddFileResult {
    if (!def || typeof def.name !== 'string' || def.name === '') {
      throw new TypeError('FileDef.name is required');
    }
    const existing = this.files.get(def.name);
    if (existing) {
      if (stableStringify(def) === stableStringify(existing.def)) {
        return {
          name: def.name,
          revision: existing.revision,
          state: existing.state,
          diagnostics: existing.diagnostics.map(cloneDiag),
          identical: true,
        };
      }
      // Peer owners of the *old* declarations must revalidate too: the new
      // revision may remove a duplicate-symbol conflict.
      const oldPeers = this.peerOwners(existing.declared, existing.name);
      this.retractDeclarations(existing);
      existing.revision += 1;
      existing.def = cloneDef(def);
      this.resetRecord(existing);
      this.registerDeclarations(existing);
      const newPeers = this.peerOwners(existing.declared, existing.name);
      this.relink(new Set([existing.name, ...oldPeers, ...newPeers]));
      return this.resultOf(existing, false);
    }

    const rec: FileRecord = {
      name: def.name,
      def: cloneDef(def),
      revision: 1,
      edges: [],
      declared: new Set(),
      state: 'pending',
      diagnostics: [],
    };
    rec.edges = classifyEdges(rec.def);
    this.files.set(rec.name, rec);
    this.registerDeclarations(rec);
    // New conflicts with already-loaded peer files invalidate those peers.
    this.relink(new Set([rec.name, ...this.peerOwners(rec.declared, rec.name)]));
    return this.resultOf(rec, false);
  }

  getFileState(name: string): FileState | undefined {
    return this.files.get(name)?.state;
  }

  getFileDescriptor(name: string): FileDescriptor | undefined {
    return this.files.get(name)?.descriptor;
  }

  getRevision(name: string): number | undefined {
    return this.files.get(name)?.revision;
  }

  pendingFiles(): string[] {
    return this.namesIn('pending');
  }

  errorFiles(): string[] {
    return this.namesIn('error');
  }

  linkedFiles(): string[] {
    return this.namesIn('linked');
  }

  findSymbol(fullName: string): unknown {
    return this.published.get(normalizeAbsolute(fullName));
  }

  findMessage(fullName: string): MessageDescriptor | undefined {
    const d = this.published.get(normalizeAbsolute(fullName));
    return isKind(d, 'message') ? (d as MessageDescriptor) : undefined;
  }

  findEnum(fullName: string): EnumDescriptor | undefined {
    const d = this.published.get(normalizeAbsolute(fullName));
    return isKind(d, 'enum') ? (d as EnumDescriptor) : undefined;
  }

  findService(fullName: string): ServiceDescriptor | undefined {
    const d = this.published.get(normalizeAbsolute(fullName));
    return isKind(d, 'service') ? (d as ServiceDescriptor) : undefined;
  }

  /**
   * Resolve a type reference exactly as the linker does and return the
   * complete lookup path plus the imported files that were searched.
   */
  lookupType(
    file: string,
    reference: string,
    scope = '',
  ): { resolved?: unknown; lookupPath: string[]; searchedImports: string[] } {
    const rec = this.files.get(file);
    if (!rec) throw new Error(`unknown file: ${file}`);
    const r = this.resolve(rec, scope, reference);
    return {
      resolved: r.target,
      lookupPath: r.lookupPath,
      searchedImports: r.searchedImports,
    };
  }

  /** Declaring files of an FQN (duplicate/conflict inspection). */
  symbolOwners(fullName: string): string[] {
    return (this.symbols.get(normalizeAbsolute(fullName)) ?? [])
      .filter((s) => s.kind !== 'package')
      .map((s) => s.file)
      .sort();
  }

  allDiagnostics(): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const rec of [...this.files.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(...rec.diagnostics.map(cloneDiag));
    }
    return out;
  }

  // -- friends used by BuildContext ----------------------------------------

  /** @internal */ declarationsAt(fullName: string): readonly SymbolEntry[] {
    return this.symbols.get(fullName) ?? [];
  }

  /** @internal */ publishShell(value: { fullName: string }): void {
    this.published.set(value.fullName, value);
  }

  // -------------------------------------------------------------------------
  // Phase 1: declaration registration
  // -------------------------------------------------------------------------

  private resetRecord(rec: FileRecord) {
    rec.edges = classifyEdges(rec.def);
    rec.declared = new Set();
    rec.descriptor = undefined;
  }

  private registerDeclarations(rec: FileRecord) {
    const pkg = rec.def.package ?? '';
    if (pkg) this.addSymbol(pkg, 'package', rec.name, scopeOf(pkg));

    for (const m of rec.def.messageType ?? []) this.registerMessage(rec, m, pkg);
    for (const e of rec.def.enumType ?? []) this.registerEnum(rec, e, pkg);
    for (const s of rec.def.service ?? []) this.registerService(rec, s, pkg);
    for (const f of rec.def.extension ?? []) this.registerExtension(rec, f, pkg);
  }

  private registerMessage(rec: FileRecord, def: MessageDef, parentFull: string) {
    const full = joinName(parentFull, def.name);
    this.addSymbol(full, 'message', rec.name, parentFull);
    rec.declared.add(full);
    for (const n of def.nestedType ?? []) this.registerMessage(rec, n, full);
    for (const e of def.enumType ?? []) this.registerEnum(rec, e, full);
    for (const f of def.extension ?? []) this.registerExtension(rec, f, full);
  }

  private registerEnum(
    rec: FileRecord,
    def: { name: string; value: { name: string }[] },
    parentFull: string,
  ) {
    const full = joinName(parentFull, def.name);
    this.addSymbol(full, 'enum', rec.name, parentFull);
    rec.declared.add(full);
    // Enum values are siblings of the enum: `.pkg.E.V` (protoc semantics).
    for (const v of def.value ?? []) {
      const vFull = joinName(full, v.name);
      this.addSymbol(vFull, 'enum-value', rec.name, full);
      rec.declared.add(vFull);
    }
  }

  private registerService(rec: FileRecord, def: { name: string }, parentFull: string) {
    const full = joinName(parentFull, def.name);
    this.addSymbol(full, 'service', rec.name, parentFull);
    rec.declared.add(full);
  }

  private registerExtension(rec: FileRecord, def: FieldDef, parentFull: string) {
    // Extensions/fields occupy their own namespace and never collide with types.
    const full = joinName(parentFull, def.name);
    this.addSymbol(full, 'extension', rec.name, parentFull);
    rec.declared.add(full);
  }

  private addSymbol(fullName: string, kind: SymbolKind, file: string, scope: string) {
    const list = this.symbols.get(fullName);
    if (list) list.push({ fullName, kind, file, scope });
    else this.symbols.set(fullName, [{ fullName, kind, file, scope }]);
  }

  private retractDeclarations(rec: FileRecord) {
    for (const [full, entries] of this.symbols) {
      const kept = entries.filter((e) => e.file !== rec.name);
      if (kept.length === 0) this.symbols.delete(full);
      else this.symbols.set(full, kept);
    }
    // The frozen descriptor objects stay alive for references callers hold;
    // only pool lookup is retracted.
    for (const full of rec.declared) this.published.delete(full);
  }

  private peerOwners(declared: Set<string>, self: string): string[] {
    const peers = new Set<string>();
    for (const full of declared) {
      for (const e of this.symbols.get(full) ?? []) {
        if (e.file !== self) peers.add(e.file);
      }
    }
    return [...peers];
  }

  private namesIn(state: FileState): string[] {
    return [...this.files.values()].filter((f) => f.state === state).map((f) => f.name).sort();
  }

  private resultOf(rec: FileRecord, identical: boolean): AddFileResult {
    return {
      name: rec.name,
      revision: rec.revision,
      state: rec.state,
      diagnostics: rec.diagnostics.map(cloneDiag),
      identical,
    };
  }

  // -------------------------------------------------------------------------
  // Phase 2: incremental linking
  // -------------------------------------------------------------------------

  private relink(seed: Set<string>) {
    // (a) Invalidate seeds and every transitive importer; retract shells.
    const affected = this.transitiveImporters(seed);
    for (const name of affected) this.retractPublications(name);

    // (b) Previously failed/pending records get retried as well.
    const candidates = new Set<string>(affected);
    for (const rec of this.files.values()) {
      if (rec.state !== 'linked') candidates.add(rec.name);
    }

    // (c) Pending closure over strong edges (weak edges never block).
    const pending = new Set<string>();
    for (const name of candidates) {
      if (this.hasMissingStrongDep(this.files.get(name)!)) pending.add(name);
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const name of candidates) {
        if (pending.has(name)) continue;
        for (const e of this.files.get(name)!.edges) {
          if (!e.weak && this.files.has(e.name) && pending.has(e.name)) {
            pending.add(name);
            grew = true;
            break;
          }
        }
      }
    }

    const buildSet = new Set<string>([...candidates].filter((n) => !pending.has(n)));
    const cyclesByFile = this.cycleDiagnostics();

    // (d) Phase A: shells for every buildable file are published before any
    //     reference is inspected — this is what lets import cycles link.
    const contexts = new Map<string, BuildContext>();
    for (const name of [...buildSet].sort()) {
      const ctx = new BuildContext(this, this.files.get(name)!);
      contexts.set(name, ctx);
      ctx.phaseA();
    }

    // (e) Phase B: fields, extensions and service method references.
    for (const name of [...buildSet].sort()) contexts.get(name)!.phaseB();

    // (f) Hard-error propagation along strong edges, fixed point.
    const failed = new Set<string>();
    for (const [name, ctx] of contexts) if (ctx.hasOwnErrors()) failed.add(name);
    let changed = true;
    while (changed) {
      changed = false;
      for (const name of buildSet) {
        if (failed.has(name)) continue;
        for (const dep of this.strongReach(this.files.get(name)!)) {
          if (failed.has(dep)) {
            failed.add(name);
            changed = true;
            break;
          }
        }
      }
    }

    // (g) Surviving files can only reference failed owners through weak-only
    //     paths; downgrade those references to weak-unresolved warnings.
    for (const name of buildSet) {
      if (!failed.has(name)) contexts.get(name)!.downgradeFailedRefs(failed);
    }

    // (h) Commit.
    for (const name of candidates) {
      const rec = this.files.get(name)!;
      if (pending.has(name)) {
        for (const f of rec.declared) this.published.delete(f);
        rec.descriptor = undefined;
        rec.state = 'pending';
        rec.diagnostics = sortDiagnostics([
          ...this.missingDependencyDiagnostics(rec),
          ...(cyclesByFile.get(name) ?? []),
        ]);
        continue;
      }
      const ctx = contexts.get(name)!;
      if (failed.has(name)) {
        for (const f of rec.declared) this.published.delete(f);
        rec.descriptor = undefined;
        rec.state = 'error';
        const diags = [...ctx.diagnostics];
        if (!ctx.hasOwnErrors()) diags.push(dependencyErrorDiag(name));
        rec.diagnostics = sortDiagnostics([...diags, ...(cyclesByFile.get(name) ?? [])]);
        continue;
      }
      const fd = ctx.fileDescriptor;
      deepFreeze(fd);
      rec.descriptor = fd;
      rec.state = 'linked';
      this.publishExtensionShells(fd);
      rec.diagnostics = sortDiagnostics([...ctx.diagnostics, ...(cyclesByFile.get(name) ?? [])]);
    }
  }

  private retractPublications(name: string) {
    const rec = this.files.get(name);
    if (!rec) return;
    for (const f of rec.declared) this.published.delete(f);
    rec.descriptor = undefined;
  }

  private hasMissingStrongDep(rec: FileRecord): boolean {
    return rec.edges.some((e) => !e.weak && !this.files.has(e.name));
  }

  private missingDependencyDiagnostics(rec: FileRecord): Diagnostic[] {
    return rec.edges
      .filter((e) => !e.weak && !this.files.has(e.name))
      .map((e) => ({
        code: 'missing-dependency' as const,
        severity: 'error' as const,
        file: rec.name,
        symbol: e.name,
        message: `missing dependency '${e.name}'${e.public ? ' (public)' : ''}`,
      }));
  }

  private transitiveImporters(seed: Set<string>): Set<string> {
    const reverse = new Map<string, Set<string>>();
    for (const rec of this.files.values()) {
      for (const e of rec.edges) {
        if (!reverse.has(e.name)) reverse.set(e.name, new Set());
        reverse.get(e.name)!.add(rec.name);
      }
    }
    const out = new Set<string>(seed);
    const queue = [...seed];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const importer of reverse.get(cur) ?? []) {
        if (!out.has(importer)) {
          out.add(importer);
          queue.push(importer);
        }
      }
    }
    return out;
  }

  private strongReach(rec: FileRecord): Set<string> {
    const out = new Set<string>();
    const queue = rec.edges.filter((e) => !e.weak).map((e) => e.name);
    while (queue.length) {
      const cur = queue.shift()!;
      if (out.has(cur)) continue;
      out.add(cur);
      const r = this.files.get(cur);
      if (r) for (const e of r.edges) if (!e.weak) queue.push(e.name);
    }
    return out;
  }

  private cycleDiagnostics(): Map<string, Diagnostic[]> {
    const byFile = new Map<string, Diagnostic[]>();
    for (const chain of findImportCycles(this.files)) {
      const message = `import dependency cycle: ${chain.join(' -> ')} -> ${chain[0]}`;
      for (const member of chain) {
        pushMap(byFile, member, {
          code: 'import-cycle',
          severity: 'warning',
          file: member,
          message,
          cycle: chain,
        });
      }
    }
    return byFile;
  }

  private publishExtensionShells(fd: FileDescriptor) {
    const walk = (m: MessageDescriptor) => {
      for (const x of m.extensions) this.published.set(x.fullName, x);
      m.nestedMessages.forEach(walk);
    };
    for (const x of fd.extensions) this.published.set(x.fullName, x);
    fd.messages.forEach(walk);
  }

  // -------------------------------------------------------------------------
  // Name resolution
  // -------------------------------------------------------------------------

  /** Direct present deps plus everything transitively reachable via public. */
  effectiveImports(rec: FileRecord): Set<string> {
    const out = new Set<string>();
    const queue: string[] = [];
    for (const e of rec.edges) if (this.files.has(e.name)) queue.push(e.name);
    while (queue.length) {
      const cur = queue.shift()!;
      if (out.has(cur)) continue;
      out.add(cur);
      const r = this.files.get(cur);
      if (!r) continue;
      for (const e of r.edges) if (e.public && this.files.has(e.name)) queue.push(e.name);
    }
    return out;
  }

  /** True when `rec` names at least one weak dependency that never arrived. */
  private hasMissingWeak(rec: FileRecord): boolean {
    return rec.edges.some((e) => e.weak && !this.files.has(e.name));
  }

  /**
   * Files reachable only through a weak edge from `rec` (direct weak targets
   * plus their public re-exports). References owned by these files tolerate
   * the owner being pending/failed (weak-unresolved instead of an error).
   */
  private weakReach(rec: FileRecord): Set<string> {
    const out = new Set<string>();
    const weakTargets = rec.edges.filter((e) => e.weak && this.files.has(e.name)).map((e) => e.name);
    const queue = weakTargets;
    while (queue.length) {
      const cur = queue.shift()!;
      if (out.has(cur)) continue;
      out.add(cur);
      const r = this.files.get(cur);
      if (!r) continue;
      for (const e of r.edges) if (e.public && this.files.has(e.name)) queue.push(e.name);
    }
    return out;
  }

  resolve(rec: FileRecord, scope: string, reference: string): ResolveResult {
    const searchedImports: string[] = [];

    if (PRIMITIVES.has(reference)) {
      return { kind: 'scalar', lookupPath: [reference], searchedImports };
    }

    const effective = this.effectiveImports(rec);
    const weakReach = this.weakReach(rec);
    const pkg = rec.def.package ?? '';

    if (reference.startsWith('.')) {
      return this.resolveAbsolute(rec, reference, normalizeAbsolute(reference), scope, effective, weakReach, searchedImports);
    }

    // Relative lookup, proto/C++ rules:
    //   * probe the first component at every lexical scope, innermost first;
    //   * package names are shared global scopes, so a head that names a
    //     package continues resolution (this is how `dep.Msg` from another
    //     package resolves at the root as `.dep.Msg`);
    //   * symbols owned by other files are reachable only through effective
    //     imports (public re-exports included);
    //   * the first scope where the head names a concrete type wins: a
    //     missing later component is a hard error there, no outer fallback.
    const lookupPath: string[] = [];
    const parts = reference.split('.');
    let headAnchor: { scope: string; headFull: string } | undefined;
    let match: { candidate: string; kind: TypeKind; file: string } | undefined;
    // Heads belonging to files this file cannot see (not imported): they are
    // reported for lookup completeness but never resolve.
    let hiddenMatch: { candidate: string; file: string } | undefined;

    for (const s of lexicalChain(scope, pkg)) {
      const candidate = joinName(s, reference);
      lookupPath.push(candidate);
      const headFull = joinName(s, parts[0]);
      const allHead = this.symbols.get(headFull) ?? [];
      const reachableHead = allHead
        .filter((e) => e.kind !== 'package')
        .find((e) => e.file === rec.name || effective.has(e.file));
      const hiddenHead = allHead
        .filter((e) => e.kind !== 'package')
        .find((e) => e.file !== rec.name && !effective.has(e.file));
      const packageHead = allHead.some((e) => e.kind === 'package');

      const fullEntries = (this.symbols.get(candidate) ?? []).filter((e) => e.kind !== 'package');
      const reachableFull = fullEntries.find((e) => e.file === rec.name || effective.has(e.file));
      const hiddenFull = fullEntries.find((e) => e.file !== rec.name && !effective.has(e.file));

      if (reachableHead) {
        // First lexical scope whose head names a visible concrete type wins
        // (protoc semantics): a missing later component is a hard error
        // there, never an outer-scope fallback.
        if (!headAnchor) headAnchor = { scope: s, headFull };
        if (reachableFull && !match && headAnchor.scope === s) {
          match = { candidate, kind: reachableFull.kind as TypeKind, file: reachableFull.file };
        }
      } else if (!headAnchor && packageHead && !hiddenHead) {
        // A shared global package scope (cross-package refs such as
        // `dep.Msg`). Hidden concrete heads at inner scopes take precedence:
        // their lexical anchor must produce a visibility error instead.
        if (reachableFull && !match) {
          match = { candidate, kind: reachableFull.kind as TypeKind, file: reachableFull.file };
        } else if (hiddenFull && !hiddenMatch) {
          hiddenMatch = { candidate, file: hiddenFull.file };
        }
      } else if (hiddenHead && !headAnchor && !hiddenMatch) {
        hiddenMatch = { candidate, file: hiddenHead.file };
      }
    }

    if (match) {
      if (match.file !== rec.name) searchedImports.push(match.file);
      // The complete lexical candidate chain is reported even though
      // resolution succeeds at the anchored scope.
      return this.finalize(rec, reference, scope, match.candidate, match.kind,
        dedupe(lookupPath), dedupe(searchedImports), effective, weakReach);
    }

    if (headAnchor) {
      // Head exists at the anchored scope but the member chain is incomplete.
      return hardUnresolved(rec, reference, scope, dedupe(lookupPath), dedupe(searchedImports),
        `cannot resolve '${reference}': '${headAnchor.headFull}' has no such member`);
    }

    if (hiddenMatch) {
      // A declaration exists globally, but this file does not import it.
      const allSearched = dedupe([...searchedImports, ...[...effective].sort()]);
      return {
        lookupPath: dedupe(lookupPath),
        searchedImports: allSearched,
        diagnostic: {
          code: 'not-imported',
          severity: 'error',
          file: rec.name,
          symbol: reference,
          scope,
          owners: [hiddenMatch.file],
          lookupPath: dedupe(lookupPath),
          searchedImports: allSearched,
          message: `'${reference}' resolves to '${hiddenMatch.candidate}' but '${rec.name}' does not import '${hiddenMatch.file}'`,
        },
      };
    }

    // Nothing found anywhere: tolerate the absence only when the file has a
    // missing weak import (the symbol plausibly came from that file).
    searchedImports.push(...[...effective].sort());
    if (this.hasMissingWeak(rec)) {
      return weakUnresolved(rec, reference, scope, dedupe(lookupPath), dedupe(searchedImports));
    }
    return hardUnresolved(rec, reference, scope, dedupe(lookupPath), dedupe(searchedImports),
      `cannot resolve type '${reference}' from scope '${scope || '(file)'}'`);
  }

  private resolveAbsolute(
    rec: FileRecord,
    reference: string,
    full: string,
    scope: string,
    effective: Set<string>,
    weakReach: Set<string>,
    searchedImports: string[],
  ): ResolveResult {
    const lookupPath = [full];
    const decls = (this.symbols.get(full) ?? []).filter((e) => e.kind !== 'package');
    if (decls.length === 0) {
      if (this.hasMissingWeak(rec)) {
        return weakUnresolved(rec, reference, scope, lookupPath, searchedImports);
      }
      return hardUnresolved(rec, reference, scope, lookupPath, searchedImports,
        `cannot resolve type '${reference}'`);
    }
    const owners = new Set(decls.map((d) => d.file));
    if (owners.size > 1) {
      return {
        lookupPath,
        searchedImports,
        diagnostic: {
          code: 'ambiguous-symbol',
          severity: 'error',
          file: rec.name,
          symbol: reference,
          scope,
          owners: [...owners].sort(),
          lookupPath,
          searchedImports,
          message: `symbol '${full}' has conflicting declarations in ${[...owners].sort().join(', ')}`,
        },
      };
    }
    return this.finalize(rec, reference, scope, full, decls[0].kind as TypeKind,
      lookupPath, searchedImports, effective, weakReach);
  }

  private finalize(
    rec: FileRecord,
    reference: string,
    scope: string,
    full: string,
    kind: TypeKind,
    lookupPath: string[],
    searchedImports: string[],
    effective: Set<string>,
    weakReach: Set<string>,
  ): ResolveResult {
    const owners = new Set(
      (this.symbols.get(full) ?? []).filter((e) => e.kind !== 'package').map((e) => e.file),
    );
    if (owners.size > 1) {
      return {
        target: undefined,
        kind,
        lookupPath,
        searchedImports,
        diagnostic: {
          code: 'ambiguous-symbol',
          severity: 'error',
          file: rec.name,
          symbol: reference,
          scope,
          owners: [...owners].sort(),
          lookupPath,
          searchedImports,
          message: `symbol '${full}' has conflicting declarations in ${[...owners].sort().join(', ')}`,
        },
      };
    }
    const owner = [...owners][0];
    if (owner !== rec.name && !effective.has(owner)) {
      const allSearched = dedupe([...searchedImports, ...[...effective].sort()]);
      // Reachable only through a weak edge: tolerate the owner's failure.
      if (weakReach.has(owner)) {
        return {
          kind,
          lookupPath,
          searchedImports: allSearched,
          diagnostic: weakDiag(rec.name, reference, scope, lookupPath, allSearched),
        };
      }
      return {
        kind,
        lookupPath,
        searchedImports: allSearched,
        diagnostic: {
          code: 'not-imported',
          severity: 'error',
          file: rec.name,
          symbol: reference,
          scope,
          owners: [owner],
          lookupPath,
          searchedImports: allSearched,
          message: `'${reference}' resolves to '${full}' but '${rec.name}' does not import '${owner}'`,
        },
      };
    }
    const descriptor = this.published.get(full);
    if (!descriptor) {
      if (owner !== rec.name && weakReach.has(owner)) {
        return {
          kind,
          lookupPath,
          searchedImports,
          diagnostic: weakDiag(rec.name, reference, scope, lookupPath, searchedImports),
        };
      }
      return {
        kind,
        lookupPath,
        searchedImports,
        diagnostic: {
          code: 'unresolved-type',
          severity: 'error',
          file: rec.name,
          symbol: reference,
          scope,
          owners: [owner],
          lookupPath,
          searchedImports,
          message: `cannot resolve type '${reference}': '${full}' is not linked yet`,
        },
      };
    }
    return { target: descriptor, kind, lookupPath, searchedImports };
  }
}

// ---------------------------------------------------------------------------
// Per-file builder
// ---------------------------------------------------------------------------

class BuildContext {
  readonly fileDescriptor: FileDescriptor;
  readonly diagnostics: Diagnostic[] = [];
  private readonly pkg: string;

  constructor(
    private readonly pool: DescriptorPool,
    private readonly rec: FileRecord,
  ) {
    this.pkg = rec.def.package ?? '';
    this.fileDescriptor = {
      kind: 'file',
      name: rec.name,
      package: this.pkg,
      syntax: rec.def.syntax === 'proto3' ? 'proto3' : 'proto2',
      revision: rec.revision,
      dependencies: rec.edges.map((e) => ({ ...e })),
      messages: [],
      enums: [],
      services: [],
      extensions: [],
    };
  }

  // Phase A: structural shells, published for cross-file resolution.
  phaseA() {
    for (const d of this.duplicateDiagnostics()) this.diagnostics.push(d);
    for (const def of this.rec.def.messageType ?? []) {
      this.fileDescriptor.messages.push(this.messageShell(def, this.pkg));
    }
    for (const def of this.rec.def.enumType ?? []) {
      this.fileDescriptor.enums.push(this.enumShell(def, this.pkg, ''));
    }
    for (const def of this.rec.def.service ?? []) {
      this.fileDescriptor.services.push(this.serviceShell(def, this.pkg));
    }
    for (const m of this.fileDescriptor.messages) publishMessageTree(this.pool, m);
    for (const e of this.fileDescriptor.enums) publishEnumTree(this.pool, e);
    for (const s of this.fileDescriptor.services) this.pool.publishShell(s);
  }

  // Phase B: fill fields/methods/extensions and link all references.
  phaseB() {
    const top = this.rec.def.messageType ?? [];
    for (let i = 0; i < top.length; i++) this.fillMessage(top[i], this.fileDescriptor.messages[i]);
    for (const def of this.rec.def.extension ?? []) {
      this.fileDescriptor.extensions.push(this.buildField(def, this.pkg, '', 'extension'));
    }
    const services = this.rec.def.service ?? [];
    for (let i = 0; i < services.length; i++) this.fillService(services[i], this.fileDescriptor.services[i]);
  }

  hasOwnErrors(): boolean {
    return this.diagnostics.some((d) => d.severity === 'error');
  }

  /**
   * References that resolved to shells owned by a now-failed file survive only
   * via weak-only edges: null the pointers and emit weak-unresolved warnings.
   */
  downgradeFailedRefs(failed: Set<string>) {
    const ownedByFailed = (d: unknown): boolean =>
      !!d && typeof d === 'object' &&
      failed.has((d as { file?: unknown }).file as string);

    const fixField = (f: FieldDescriptor) => {
      if (f.resolvedType && ownedByFailed(f.resolvedType)) {
        f.resolvedType = undefined;
        f.weakUnresolved = true;
        this.diagnostics.push(weakDiag(this.rec.name, f.typeName ?? f.name, f.containingFullName));
      }
      if (f.resolvedExtendee && ownedByFailed(f.resolvedExtendee)) {
        f.resolvedExtendee = undefined;
        f.weakUnresolved = true;
        this.diagnostics.push(weakDiag(this.rec.name, f.extendee ?? f.name, f.containingFullName));
      }
    };

    for (const m of this.fileDescriptor.messages) walkFields(m, fixField);
    for (const x of this.fileDescriptor.extensions) fixField(x);

    for (const s of this.fileDescriptor.services) {
      for (const m of s.methods) {
        if (m.resolvedInput && ownedByFailed(m.resolvedInput)) {
          m.resolvedInput = undefined;
          m.weakUnresolved.push(m.inputType);
          this.diagnostics.push(weakDiag(this.rec.name, m.inputType, s.fullName));
        }
        if (m.resolvedOutput && ownedByFailed(m.resolvedOutput)) {
          m.resolvedOutput = undefined;
          m.weakUnresolved.push(m.outputType);
          this.diagnostics.push(weakDiag(this.rec.name, m.outputType, s.fullName));
        }
      }
    }
  }

  // -- shells ---------------------------------------------------------------

  private messageShell(def: MessageDef, parentFull: string): MessageDescriptor {
    const full = joinName(parentFull, def.name);
    return {
      kind: 'message',
      name: def.name,
      fullName: full,
      file: this.rec.name,
      containingFullName: parentFull === this.pkg ? '' : parentFull,
      fields: [],
      nestedMessages: (def.nestedType ?? []).map((n) => this.messageShell(n, full)),
      nestedEnums: (def.enumType ?? []).map((e) => this.enumShell(e, full, full)),
      extensions: [],
      extensionRanges: (def.extensionRange ?? []).map((r) => ({ start: r.start, end: r.end })),
    };
  }

  private enumShell(
    def: { name: string; value: { name: string; number: number }[] },
    parentFull: string,
    containing: string,
  ): EnumDescriptor {
    const full = joinName(parentFull, def.name);
    const values: EnumValueDescriptor[] = (def.value ?? []).map((v) => ({
      kind: 'enum-value',
      name: v.name,
      fullName: joinName(full, v.name),
      number: v.number,
      file: this.rec.name,
    }));
    return {
      kind: 'enum',
      name: def.name,
      fullName: full,
      file: this.rec.name,
      containingFullName: containing,
      values,
    };
  }

  private serviceShell(def: { name: string }, parentFull: string): ServiceDescriptor {
    return {
      kind: 'service',
      name: def.name,
      fullName: joinName(parentFull, def.name),
      file: this.rec.name,
      methods: [],
    };
  }

  // -- fill -----------------------------------------------------------------

  private fillMessage(def: MessageDef, msg: MessageDescriptor) {
    for (const f of def.field ?? []) {
      msg.fields.push(this.buildField(f, msg.fullName, msg.fullName, 'field'));
    }
    for (let i = 0; i < (def.nestedType ?? []).length; i++) {
      this.fillMessage(def.nestedType![i], msg.nestedMessages[i]);
    }
    for (const x of def.extension ?? []) {
      msg.extensions.push(this.buildField(x, msg.fullName, msg.fullName, 'extension'));
    }
  }

  private fillService(def: ServiceDefInput, svc: ServiceDescriptor) {
    for (const m of def.method ?? []) {
      const method: MethodDescriptor = {
        name: m.name,
        fullName: joinName(svc.fullName, m.name),
        inputType: m.inputType,
        outputType: m.outputType,
        clientStreaming: !!m.clientStreaming,
        serverStreaming: !!m.serverStreaming,
        weakUnresolved: [],
      };
      const inp = this.resolveRef(m.inputType, svc.fullName, ['message']);
      if (inp.target && isKind(inp.target, 'message')) method.resolvedInput = inp.target as MessageDescriptor;
      if (inp.weak) method.weakUnresolved.push(m.inputType);
      const out = this.resolveRef(m.outputType, svc.fullName, ['message']);
      if (out.target && isKind(out.target, 'message')) method.resolvedOutput = out.target as MessageDescriptor;
      if (out.weak) method.weakUnresolved.push(m.outputType);
      svc.methods.push(method);
    }
  }

  private buildField(def: FieldDef, scope: string, containing: string, fieldKind: 'field' | 'extension'): FieldDescriptor {
    const fd: FieldDescriptor = {
      kind: fieldKind,
      name: def.name,
      fullName: joinName(scope, def.name),
      file: this.rec.name,
      number: def.number,
      label: def.label ?? 'optional',
      type: def.type,
      typeName: def.typeName,
      containingFullName: containing,
    };

    if (def.typeName) {
      const r = this.resolveRef(def.typeName, scope, ['message', 'enum']);
      if (r.target) {
        fd.resolvedType = r.target as MessageDescriptor | EnumDescriptor;
        fd.type = isKind(r.target, 'enum') ? 'enum' : 'message';
      }
      if (r.weak) fd.weakUnresolved = true;
    } else if (!def.type) {
      this.error('invalid-definition', `field '${def.name}' has neither type nor typeName`, def.name, scope);
    }

    if (def.extendee) {
      fd.extendee = def.extendee;
      const r = this.resolveRef(def.extendee, scope, ['message']);
      if (r.target && isKind(r.target, 'message')) fd.resolvedExtendee = r.target as MessageDescriptor;
      if (r.weak) fd.weakUnresolved = true;
    }
    return fd;
  }

  private resolveRef(reference: string, scope: string, expected: TypeKind[]): { target?: unknown; weak: boolean } {
    const r = this.pool.resolve(this.rec, scope, reference);
    if (r.diagnostic) this.diagnostics.push(r.diagnostic);
    const weak = r.diagnostic?.code === 'weak-unresolved';
    if (r.target) {
      if (r.kind === 'scalar' || !expected.includes(r.kind as TypeKind)) {
        this.error('invalid-definition',
          `'${reference}' is ${r.kind}, expected ${expected.join(' or ')}`, reference, scope);
        return { weak };
      }
      return { target: r.target, weak };
    }
    return { weak };
  }

  // -- duplicates -----------------------------------------------------------

  private duplicateDiagnostics(): Diagnostic[] {
    const out: Diagnostic[] = [];
    const reported = new Set<string>();
    for (const full of this.rec.declared) {
      const entries = this.pool.declarationsAt(full).filter(
        (e) => e.kind !== 'package' && e.kind !== 'enum-value',
      );
      const sameFile = entries.filter((e) => e.file === this.rec.name);
      const owners = new Set(entries.map((e) => e.file));
      const duplicated = owners.size > 1 || sameFile.length > 1;
      if (!duplicated || reported.has(full)) continue;
      reported.add(full);
      const kinds = new Set(entries.map((e) => e.kind));
      const code: DiagnosticCode = kinds.size > 1 ? 'ambiguous-symbol' : 'duplicate-symbol';
      out.push({
        code,
        severity: 'error',
        file: this.rec.name,
        symbol: full,
        owners: [...owners].sort(),
        message:
          kinds.size > 1
            ? `symbol '${full}' is declared with different kinds in ${[...owners].sort().join(', ')}`
            : `duplicate symbol '${full}' declared in ${[...owners].sort().join(', ')}`,
      });
    }
    return out;
  }

  private error(code: DiagnosticCode, message: string, symbol: string, scope: string) {
    this.diagnostics.push({ code, severity: 'error', file: this.rec.name, symbol, scope, message });
  }
}

interface ServiceDefInput {
  name: string;
  method?: {
    name: string;
    inputType: string;
    outputType: string;
    clientStreaming?: boolean;
    serverStreaming?: boolean;
  }[];
}

// ---------------------------------------------------------------------------
// Shell publishing
// ---------------------------------------------------------------------------

function publishMessageTree(pool: DescriptorPool, msg: MessageDescriptor) {
  pool.publishShell(msg);
  for (const n of msg.nestedMessages) publishMessageTree(pool, n);
  for (const e of msg.nestedEnums) publishEnumTree(pool, e);
}

function publishEnumTree(pool: DescriptorPool, e: EnumDescriptor) {
  pool.publishShell(e);
  for (const v of e.values) pool.publishShell(v);
}

function walkFields(msg: MessageDescriptor, fix: (f: FieldDescriptor) => void) {
  for (const f of msg.fields) fix(f);
  for (const x of msg.extensions) fix(x);
  for (const n of msg.nestedMessages) walkFields(n, fix);
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

/**
 * Import cycles, each canonicalized (rotated to the lexicographically
 * smallest rotation) so diagnostics are independent of load/traversal order.
 */
function findImportCycles(files: Map<string, FileRecord>): string[][] {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const name of files.keys()) color.set(name, WHITE);

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const stack: string[] = [];

  const canonical = (chain: string[]): string[] => {
    let best = chain.slice();
    for (let i = 1; i < chain.length; i++) {
      const rot = [...chain.slice(i), ...chain.slice(0, i)];
      if (rot.join(' ') < best.join(' ')) best = rot;
    }
    return best;
  };

  const dfs = (u: string) => {
    color.set(u, GRAY);
    stack.push(u);
    const rec = files.get(u)!;
    for (const e of rec.edges) {
      if (!files.has(e.name)) continue;
      if (color.get(e.name) === GRAY) {
        const chain = canonical(stack.slice(stack.indexOf(e.name)));
        const key = chain.join(' -> ');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(chain);
        }
      } else if (color.get(e.name) === WHITE) {
        dfs(e.name);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };

  for (const name of [...files.keys()].sort()) {
    if (color.get(name) === WHITE) dfs(name);
  }
  return cycles.sort((a, b) => a.join(' ').localeCompare(b.join(' ')));
}

// ---------------------------------------------------------------------------
// Diagnostics / utilities
// ---------------------------------------------------------------------------

function hardUnresolved(
  rec: FileRecord,
  reference: string,
  scope: string,
  lookupPath: string[],
  searchedImports: string[],
  message: string,
): ResolveResult {
  return {
    lookupPath,
    searchedImports,
    diagnostic: {
      code: 'unresolved-type',
      severity: 'error',
      file: rec.name,
      symbol: reference,
      scope,
      lookupPath,
      searchedImports,
      message,
    },
  };
}

function weakUnresolved(
  rec: FileRecord,
  reference: string,
  scope: string,
  lookupPath: string[],
  searchedImports: string[],
): ResolveResult {
  return {
    lookupPath,
    searchedImports,
    diagnostic: weakDiag(rec.name, reference, scope, lookupPath, searchedImports),
  };
}

function weakDiag(
  file: string,
  reference: string,
  scope: string,
  lookupPath: string[] = [],
  searchedImports: string[] = [],
): Diagnostic {
  return {
    code: 'weak-unresolved',
    severity: 'warning',
    file,
    symbol: reference,
    scope,
    lookupPath,
    searchedImports,
    message: `weak reference '${reference}' is unavailable (weak import missing)`,
  };
}

function dependencyErrorDiag(file: string): Diagnostic {
  return {
    code: 'dependency-error',
    severity: 'error',
    file,
    message: 'file could not be linked because a strongly imported dependency has errors',
  };
}

function classifyEdges(def: FileDef): FileDependencyDescriptor[] {
  const map = new Map<string, { public: boolean; weak: boolean }>();
  (def.dependency ?? []).forEach((name, i) => {
    const entry = map.get(name) ?? { public: false, weak: false };
    if (def.publicDependency?.includes(i)) entry.public = true;
    if (def.weakDependency?.includes(i)) entry.weak = true;
    map.set(name, entry);
  });
  return [...map.entries()]
    .map(([name, v]) => ({ name, public: v.public, weak: v.weak }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function lexicalChain(scope: string, pkg: string): string[] {
  const out: string[] = [];
  if (scope) {
    out.push(scope);
    let s = scope;
    while (s.includes('.')) {
      s = s.substring(0, s.lastIndexOf('.'));
      out.push(s);
    }
    if (pkg && !out.includes(pkg)) out.push(pkg);
  } else if (pkg) {
    out.push(pkg);
  }
  out.push('');
  return out;
}

function joinName(parent: string, name: string): string {
  return parent ? `${parent}.${name}` : name;
}

function scopeOf(full: string): string {
  const i = full.lastIndexOf('.');
  return i < 0 ? '' : full.substring(0, i);
}

function normalizeAbsolute(ref: string): string {
  return ref.startsWith('.') ? ref.slice(1) : ref;
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function isKind(d: unknown, kind: string): boolean {
  return !!d && typeof d === 'object' && (d as { kind?: unknown }).kind === kind;
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function deepFreeze<T>(obj: T): T {
  const seen = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    const o = value as Record<string, unknown>;
    if (seen.has(o) || Object.isFrozen(o)) return;
    seen.add(o);
    for (const key of Object.keys(o)) freeze(o[key]);
    Object.freeze(o);
  };
  freeze(obj);
  return obj;
}

function sortDiagnostics(diags: Diagnostic[]): Diagnostic[] {
  return diags
    .map(cloneDiag)
    .sort((a, b) =>
      (a.file ?? '').localeCompare(b.file ?? '') ||
      a.code.localeCompare(b.code) ||
      a.severity.localeCompare(b.severity) ||
      (a.symbol ?? '').localeCompare(b.symbol ?? '') ||
      a.message.localeCompare(b.message),
    );
}

function cloneDiag(d: Diagnostic): Diagnostic {
  return {
    ...d,
    lookupPath: d.lookupPath ? [...d.lookupPath] : undefined,
    searchedImports: d.searchedImports ? [...d.searchedImports] : undefined,
    cycle: d.cycle ? [...d.cycle] : undefined,
    owners: d.owners ? [...d.owners] : undefined,
  };
}

function cloneDef(def: FileDef): FileDef {
  return structuredClone(def);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}
