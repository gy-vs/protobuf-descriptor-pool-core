/**
 * Descriptor model.
 *
 * The input side ({@link FileDef} and friends) is a proto FileDescriptorProto
 * shaped, mutable view as supplied by callers. The pool never mutates these
 * objects. The output side ({@link FileDescriptor} and friends) is produced by
 * the pool once a file is linked and is deeply frozen: a published descriptor
 * never changes identity or content for the lifetime of that revision.
 */

export type FieldLabel = 'optional' | 'required' | 'repeated';

export type ScalarType =
  | 'double' | 'float' | 'int64' | 'uint64' | 'int32' | 'fixed64'
  | 'fixed32' | 'bool' | 'string' | 'bytes' | 'uint32' | 'sfixed32'
  | 'sfixed64' | 'sint32' | 'sint64';

export type FieldTypeKind = ScalarType | 'message' | 'enum' | 'group';

export interface FieldDef {
  name: string;
  number: number;
  label?: FieldLabel;
  /** Scalar name, or 'message'/'enum' when {@link FieldDef.typeName} is set. */
  type?: FieldTypeKind;
  /** Type reference as written: '.pkg.Msg', 'Inner.Enum', etc. */
  typeName?: string;
  jsonName?: string;
  defaultValue?: string;
  /** Present on extension fields: the message being extended. */
  extendee?: string;
}

export interface EnumValueDef {
  name: string;
  number: number;
}

export interface EnumDef {
  name: string;
  value: EnumValueDef[];
  allowAlias?: boolean;
}

export interface ExtensionRangeDef {
  start: number;
  end: number;
}

export interface MessageDef {
  name: string;
  field?: FieldDef[];
  nestedType?: MessageDef[];
  enumType?: EnumDef[];
  /** Extension fields declared within this message's body. */
  extension?: FieldDef[];
  extensionRange?: ExtensionRangeDef[];
}

export interface MethodDef {
  name: string;
  inputType: string;
  outputType: string;
  clientStreaming?: boolean;
  serverStreaming?: boolean;
}

export interface ServiceDef {
  name: string;
  method: MethodDef[];
}

export interface FileDef {
  name: string;
  package?: string;
  /** File names imported by this file. */
  dependency?: string[];
  /** Indexes into {@link FileDef.dependency} that are `import public`. */
  publicDependency?: number[];
  /** Indexes into {@link FileDef.dependency} that are `import weak`. */
  weakDependency?: number[];
  messageType?: MessageDef[];
  enumType?: EnumDef[];
  service?: ServiceDef[];
  /** File-level extension fields. */
  extension?: FieldDef[];
  syntax?: 'proto2' | 'proto3';
}

// ---------------------------------------------------------------------------
// Published (linked, immutable) descriptors
// ---------------------------------------------------------------------------

export interface ExtensionRangeDescriptor {
  start: number;
  end: number;
}

export interface EnumValueDescriptor {
  kind: 'enum-value';
  name: string;
  fullName: string;
  number: number;
  file: string;
}

export interface EnumDescriptor {
  kind: 'enum';
  name: string;
  fullName: string;
  file: string;
  /** '' for a top-level enum, otherwise the containing message full name. */
  containingFullName: string;
  values: EnumValueDescriptor[];
}

export interface FieldDescriptor {
  kind: 'field' | 'extension';
  name: string;
  fullName: string;
  file: string;
  number: number;
  label: FieldLabel;
  type?: FieldTypeKind;
  /** Reference as written in the source, retained for diagnostics. */
  typeName?: string;
  /** Linked message/enum target. Absent when the ref is weak-unresolved. */
  resolvedType?: MessageDescriptor | EnumDescriptor;
  /** Containing message full name, or '' for a file-level extension. */
  containingFullName: string;
  extendee?: string;
  resolvedExtendee?: MessageDescriptor;
  /** Set when this reference could not be linked because a weak import is unavailable. */
  weakUnresolved?: boolean;
}

export interface MessageDescriptor {
  kind: 'message';
  name: string;
  fullName: string;
  file: string;
  /** '' for a top-level message. */
  containingFullName: string;
  fields: FieldDescriptor[];
  nestedMessages: MessageDescriptor[];
  nestedEnums: EnumDescriptor[];
  extensions: FieldDescriptor[];
  extensionRanges: ExtensionRangeDescriptor[];
}

export interface MethodDescriptor {
  name: string;
  fullName: string;
  inputType: string;
  outputType: string;
  resolvedInput?: MessageDescriptor;
  resolvedOutput?: MessageDescriptor;
  clientStreaming: boolean;
  serverStreaming: boolean;
  /** Reference spellings that failed against an unavailable weak import. */
  weakUnresolved: string[];
}

export interface ServiceDescriptor {
  kind: 'service';
  name: string;
  fullName: string;
  file: string;
  methods: MethodDescriptor[];
}

export interface FileDependencyDescriptor {
  name: string;
  public: boolean;
  weak: boolean;
}

export interface FileDescriptor {
  kind: 'file';
  name: string;
  package: string;
  syntax: 'proto2' | 'proto3';
  revision: number;
  dependencies: FileDependencyDescriptor[];
  messages: MessageDescriptor[];
  enums: EnumDescriptor[];
  services: ServiceDescriptor[];
  extensions: FieldDescriptor[];
}

export type FileState = 'pending' | 'linked' | 'error';

export type DiagnosticCode =
  | 'missing-dependency'
  | 'unresolved-type'
  | 'ambiguous-symbol'
  | 'duplicate-symbol'
  | 'not-imported'
  | 'import-cycle'
  | 'weak-unresolved'
  | 'dependency-error'
  | 'invalid-definition';

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  file?: string;
  /** Reference symbol as written ('Foo.Bar', '.abs.X', extendee, ...). */
  symbol?: string;
  /** Lexical scope the reference was made from ('' = file scope). */
  scope?: string;
  /** Fully qualified candidates tried, innermost scope first. */
  lookupPath?: string[];
  /** Imported file names searched during the import fallback. */
  searchedImports?: string[];
  /** Canonicalized import chain describing a dependency cycle. */
  cycle?: string[];
  /** Files involved (duplicate owners, ambiguity candidates, ...). */
  owners?: string[];
}

export interface AddFileResult {
  name: string;
  revision: number;
  state: FileState;
  diagnostics: Diagnostic[];
  /** True when the identical file was already registered (no revision bump). */
  identical: boolean;
}
