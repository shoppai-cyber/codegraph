/**
 * Round-10 regression tests — consolidated repairs for the round-9 adversarial panel.
 *
 *  - Codex F1 / Opus F1: comments on kept preprocessor directives (fabricates from dead
 *    `#if false // c` text; suppresses legal files when a kept directive's comment carries
 *    an odd quote).
 *  - Opus F2: excluded (`#if false`) text is not lexed by the compiler — an unterminated
 *    literal there must not suppress the file's active code.
 *  - Codex F2: interpolated raw strings permit opening brace runs of N+1..2N-1 (outer braces
 *    are literal content, innermost N open the hole).
 *  - Codex F3: compiler-rejected raw-string fence/layout forms must suppress, and the legal
 *    layout forms (blank/short whitespace-only lines, hole-interior lines) must not.
 *  - Codex F4: unmatched/overlong closing braces in interpolated strings must suppress.
 *  - GLM F-LOW-1: a base token whose spelling starts with a Cf formatting character is not a
 *    legal identifier and must never resolve to a host base.
 *  - Opus advisories: compound `#if` expressions fold provable constants; form-feed counts as
 *    whitespace before a directive `#`.
 *
 * Every legality expectation is anchored to a dotnet (C# 12) compiler receipt: the round-9
 * panel receipts under scratch/round9-review/codex/round9-compiler/ and the round-10 batch
 * recorded in the validation record (WsEmptyLine/WsShortLine LEGAL, WsTabLine CS9003,
 * WsContentShort CS8999, RawHoleLineNoIndent/RawHoleMultiNoIndent LEGAL, RawCloseAfterHole
 * CS9000, PPDeadUnterminatedString/PPDeadUnterminatedRawFence LEGAL, PPCompoundFalse LEGAL,
 * PPCompoundTrueOr LEGAL, FormFeedRegion/FormFeedIf LEGAL, PPIfQuoteJunk CS1025,
 * PPElifChain LEGAL).
 */

import { describe, it, expect } from 'vitest';
import { unityResolver } from '../src/resolution/frameworks/unity';
import type { FrameworkExtractionResult } from '../src/resolution/types';

function extract(source: string, filePath = 'Assets/Scripts/Player.cs'): FrameworkExtractionResult {
  return unityResolver.extract!(filePath, source);
}

function nodeNames(result: FrameworkExtractionResult): string[] {
  return result.nodes.map((n) => n.name).sort();
}

function refPairs(result: FrameworkExtractionResult): string[] {
  return result.references.map((r) => `${r.referenceKind}:${r.referenceName}`).sort();
}

const STD_NODES = [
  'UNITY NetworkBehaviour.OnStartServer Player.OnStartServer',
  'UNITY attribute Command Player.CmdFire',
].sort();
const STD_REFS = [
  'references:unity:host:Player.OnStartServer',
  'references:unity:method:Player.CmdFire',
].sort();

function playerClass(extra = ''): string {
  const field = extra ? `    ${extra}\n` : '';
  return `public class Player : NetworkBehaviour\n{\n${field}    public override void OnStartServer() { }\n    [Command] void CmdFire() { }\n}`;
}

function expectStd(result: FrameworkExtractionResult): void {
  expect(nodeNames(result)).toEqual(STD_NODES);
  expect(refPairs(result)).toEqual(STD_REFS);
}

function expectEmpty(result: FrameworkExtractionResult): void {
  expect(result).toEqual({ nodes: [], references: [] });
}

describe('Round 10 — comments on kept preprocessor directives (Codex F1 / Opus F1)', () => {
  it('emits from a provably-active region whose #if carries a line comment (PP02, LegalPPLineComment)', () => {
    const result = extract(
      `#define SYMBOL\n#if SYMBOL // active comment\nusing Mirror;\n${playerClass()}\n#endif\n`
    );
    expectStd(result);
  });

  it('does not fabricate from a #if false region whose directive carries a line comment (PP03, LegalPPFalseLineComment)', () => {
    const result = extract(
      `using Mirror;\n#if false // inactive comment\nclass Ghost : NetworkBehaviour\n{\n    public override void OnStartServer() { }\n    [Command] void CmdGhost() { }\n}\n#endif\n${playerClass()}\n`
    );
    expectStd(result);
  });

  it('an odd quote in a kept #endif/#define comment must not desynchronize (PP07/PP08)', () => {
    const result = extract(
      `#define S // odd "\n#if S // c\nusing Mirror;\n${playerClass()}\n#endif // odd "\n`
    );
    expectStd(result);
  });

  it('odd quotes in #elif/#else comments must not desynchronize (PP09/PP10, PPElifChain receipt)', () => {
    const result = extract(
      `#if false // c\n#elif true // odd "\n#else // odd "\n#endif\nusing Mirror;\n${playerClass()}\n`
    );
    expectStd(result);
  });

  it('an odd quote in a kept #undef comment must not desynchronize (PP11)', () => {
    const result = extract(
      `#define S\n#undef S // odd "\nusing Mirror;\n${playerClass()}\n`
    );
    expectStd(result);
  });

  it('a block comment on a conditional directive cannot compile — whole file suppresses (PP04, CS1025)', () => {
    const result = extract(
      `using Mirror;\n#if false /* block */\nclass Ghost : NetworkBehaviour\n{\n    public override void OnStartServer() { }\n}\n#endif\n${playerClass()}\n`
    );
    expectEmpty(result);
  });

  it('a stray quote in a kept directive expression cannot compile — whole file suppresses (PPIfQuoteJunk, CS1025)', () => {
    const result = extract(`using Mirror;\n#if SYMBOL "junk\n${playerClass()}\n#endif\n`);
    expectEmpty(result);
  });
});

describe('Round 10 — excluded text is not lexed (Opus F2)', () => {
  it('an unterminated string inside #if false must not suppress the active code (PPDeadUnterminatedString)', () => {
    const result = extract(
      `using Mirror;\n#if false\nstring s = "unterminated\n#endif\n${playerClass()}\n`
    );
    expectStd(result);
  });

  it('an unterminated raw fence inside #if false must not suppress the active code (PPDeadUnterminatedRawFence)', () => {
    const result = extract(
      `using Mirror;\n#if false\nvar x = """\nnever closed\n#endif\n${playerClass()}\n`
    );
    expectStd(result);
  });

  it('declarations inside #if false never emit even when lexable', () => {
    const result = extract(
      `using Mirror;\n#if false\nclass Ghost : NetworkBehaviour\n{\n    public override void OnStartServer() { }\n}\n#endif\n${playerClass()}\n`
    );
    expectStd(result);
  });
});

describe('Round 10 — compound #if constant folding (Opus advisory)', () => {
  it('#if false && true is provably false — no fabrication from its region (PPCompoundFalse)', () => {
    const result = extract(
      `using Mirror;\n#if false && true\nclass Ghost : NetworkBehaviour\n{\n    public override void OnStartServer() { }\n}\n#endif\n${playerClass()}\n`
    );
    expectStd(result);
  });

  it('#if true || UNKNOWN is provably true — its region provides evidence (PPCompoundTrueOr)', () => {
    const result = extract(
      `#if true || UNDEFINED_SYMBOL_XYZ\nusing Mirror;\n${playerClass()}\n#endif\n`
    );
    expectStd(result);
  });

  it('#if false || UNKNOWN stays unknown — no evidence, no fabrication', () => {
    const result = extract(
      `#if false || UNDEFINED_SYMBOL_XYZ\nusing Mirror;\n${playerClass()}\n#endif\n`
    );
    expectEmpty(result);
  });
});

describe('Round 10 — legal raw-interpolation brace runs (Codex F2)', () => {
  it('opening runs of N+1..2N-1 are legal content + hole (IR03/IR04/IR05, LegalRawBraceRuns)', () => {
    const bodies = [
      'string a = $$"""{{{1 + 2}}}""";',
      'string b = $$$"""{{{{1 + 2}}}}""";',
      'string c = $$$"""{{{{{1 + 2}}}}}""";',
    ];
    for (const body of bodies) {
      const result = extract(`using Mirror;\n${playerClass(body)}\n`);
      expectStd(result);
    }
  });

  it('an opening run of 2N or more cannot compile — suppresses (IR12 direction)', () => {
    const result = extract(
      `using Mirror;\n${playerClass('string s = $$"""{{{{1 + 2}}}}""";')}\n`
    );
    expectEmpty(result);
  });
});

describe('Round 10 — compiler-rejected raw-string layouts suppress (Codex F3)', () => {
  it('suppresses an overlong closing quote run (R08, CS8998)', () => {
    const result = extract(`using Mirror;\n${playerClass('string s = """data"""";')}\n`);
    expectEmpty(result);
  });

  it('suppresses a single-line raw opener continued across lines (R09, CS8997)', () => {
    const source = [
      'using Mirror;',
      'public class Player : NetworkBehaviour',
      '{',
      '    string s = """data',
      'more',
      '""";',
      '    public override void OnStartServer() { }',
      '    [Command] void CmdFire() { }',
      '}',
      '',
    ].join('\n');
    expectEmpty(extract(source));
  });

  it('suppresses a multiline close with content on the closing line (R10, CS9000)', () => {
    const source = [
      'using Mirror;',
      'public class Player : NetworkBehaviour',
      '{',
      '    string s = """',
      'data',
      'tail """;',
      '    public override void OnStartServer() { }',
      '    [Command] void CmdFire() { }',
      '}',
      '',
    ].join('\n');
    expectEmpty(extract(source));
  });

  it('suppresses under-indented content vs the closing delimiter (R11, CS8999 / WsContentShort)', () => {
    const source = [
      'using Mirror;',
      'public class Player : NetworkBehaviour',
      '{',
      '    string s = """',
      '  too-shallow',
      '    """;',
      '    public override void OnStartServer() { }',
      '    [Command] void CmdFire() { }',
      '}',
      '',
    ].join('\n');
    expectEmpty(extract(source));
  });

  it('keeps a legal multiline raw string with an empty and a shorter whitespace-only line (WsEmptyLine/WsShortLine)', () => {
    const source = [
      'using Mirror;',
      'public class Player : NetworkBehaviour',
      '{',
      '    string s = """',
      '        content',
      '',
      '    ',
      '        """;',
      '    public override void OnStartServer() { }',
      '    [Command] void CmdFire() { }',
      '}',
      '',
    ].join('\n');
    expectStd(extract(source));
  });

  it('suppresses a whitespace-only line whose whitespace differs in kind from the closing line (WsTabLine, CS9003)', () => {
    const source = [
      'using Mirror;',
      'public class Player : NetworkBehaviour',
      '{',
      '    string s = """',
      '        content',
      '\t',
      '        """;',
      '    public override void OnStartServer() { }',
      '    [Command] void CmdFire() { }',
      '}',
      '',
    ].join('\n');
    expectEmpty(extract(source));
  });

  it('keeps hole-interior lines exempt from the indentation rule (RawHoleLineNoIndent/RawHoleMultiNoIndent)', () => {
    const source = [
      'using Mirror;',
      'public class Player : NetworkBehaviour',
      '{',
      '    string s = $$"""',
      '        content {{1 +',
      '2}}',
      '        """;',
      '    public override void OnStartServer() { }',
      '    [Command] void CmdFire() { }',
      '}',
      '',
    ].join('\n');
    expectStd(extract(source));
  });

  it('suppresses a closing fence sharing its line with a hole end (RawCloseAfterHole, CS9000)', () => {
    const source = [
      'using Mirror;',
      'public class Player : NetworkBehaviour',
      '{',
      '    string s = $$"""',
      '        content {{',
      '1',
      '}}""";',
      '    public override void OnStartServer() { }',
      '    [Command] void CmdFire() { }',
      '}',
      '',
    ].join('\n');
    expectEmpty(extract(source));
  });
});

describe('Round 10 — unmatched/overlong closing braces suppress (Codex F4)', () => {
  it('suppresses an overlong closing run after a hole (IR10, CS9007)', () => {
    const result = extract(
      `using Mirror;\n${playerClass('string s = $$"""{{1 + 2}}}}""";')}\n`
    );
    expectEmpty(result);
  });

  it('suppresses an unmatched closing run in raw content (IR11, CS9007)', () => {
    const result = extract(
      `using Mirror;\n${playerClass('string s = $$"""payload }} tail""";')}\n`
    );
    expectEmpty(result);
  });

  it('suppresses a lone closing brace in a normal interpolated string (IN09, CS8086)', () => {
    const result = extract(
      `using Mirror;\n${playerClass('string s = $"payload } tail";')}\n`
    );
    expectEmpty(result);
  });

  it('keeps a legal N..2N-1 closing run (hole close + literal remainder, LegalRawBraceRuns)', () => {
    const result = extract(
      `using Mirror;\n${playerClass('string s = $$"""{{{1 + 2}}} raw""";')}\n`
    );
    expectStd(result);
  });
});

describe('Round 10 — leading formatting character in a base token (GLM F-LOW-1)', () => {
  it('a base token whose spelling starts with a Cf character never resolves to a host', () => {
    const result = extract(
      `using Mirror;\nnamespace Legal;\npublic class Player : ‍NetworkBehaviour\n{\n    public override void OnStartServer() { }\n}\n`
    );
    expectEmpty(result);
  });

  it('a Cf character inside a base token is still spelling only (round-8 identity preserved)', () => {
    const result = extract(
      `using Mirror;\npublic class Player : Net‍workBehaviour\n{\n    public override void OnStartServer() { }\n    [Command] void CmdFire() { }\n}\n`
    );
    expectStd(result);
  });
});

describe('Round 10 — exotic whitespace before directives (Opus advisory)', () => {
  it('recognizes a form-feed-indented #if false (FormFeedIf)', () => {
    const result = extract(
      `using Mirror;\n\f#if false\nclass Ghost : NetworkBehaviour\n{\n    public override void OnStartServer() { }\n}\n#endif\n${playerClass()}\n`
    );
    expectStd(result);
  });

  it('blanks the freeform tail of a form-feed-indented #region (FormFeedRegion)', () => {
    const result = extract(
      `using Mirror;\n\f#region has an odd " quote\n${playerClass()}\n\f#endregion\n`
    );
    expectStd(result);
  });
});
