import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import CodeGraph from '../src/index';
import { buildGroveEphemeralDataflow } from '../src/analysis/grove-ephemeral-dataflow';
import { ToolHandler } from '../src/mcp/tools';

const PIPELINE_SOURCE = `from src.grove import node_tree
from src.grove.geo import compare, math

@node_tree(id="pipeline", target="geometry")
def producer(geometry, Threshold):
    scaled = math(value=Threshold, value_001=2.0)
    passed = compare(a=scaled, b=Threshold)
    return geometry, scaled, passed

def consumer(geometry, cap, active):
    return geometry

@node_tree(id="pipeline.root", target="geometry")
def root(geometry, Threshold):
    front, cap, active = producer(geometry=geometry, Threshold=Threshold)
    return consumer(geometry=front, cap=cap, active=active)
`;

const ZONE_SOURCE = `from src.grove import node_tree, repeat_zone, simulation_zone
from src.grove.geo import boolean_math, compare, math

@node_tree(id="zones", target="geometry")
def roof(FlatTop, MaxRise):
    front0 = math(value=MaxRise, value_001=1.0)
    @repeat_zone(iterations=4)
    def solve(front, capped, index):
        measured = compare(a=front, b=MaxRise)
        next_capped = boolean_math(boolean=capped, boolean_001=measured)
        @simulation_zone
        def state(front, active):
            return front, active
        state_front, state_active = state(front, next_capped)
        return front, state_active
    front_end, capped_end = solve(front0, False)
    result = skel_cap_emit(front=front_end, cap=MaxRise, active=capped_end)
    return result

def skel_cap_emit(front, cap, active):
    return front
`;

const INGESTED_SOURCE = `from src.grove import node_tree

@node_tree(id="ingested", target="geometry", interface_order=["InputValue"], interface_layout=["InputValue"])
def ingested(InputValue):
    doubled = InputValue
    return doubled
`;

const SNAPSHOT_SOURCE = `from src.grove import node_tree

@node_tree(id="pipeline", target="geometry")
def producer(geometry, Threshold):
    scaled = Threshold
    return geometry, scaled
`;

const NON_GROVE_SOURCE = `def ordinary(InputValue):
    doubled = InputValue
    return doubled
`;

const POSITIONAL_KEYWORD_SOURCE = `from src.grove import node_tree

def producer(left, right):
    return left, right

def consumer(left, right):
    return left

@node_tree(id="positional-keyword", target="geometry")
def root(InputValue, OtherValue):
    first, second = producer(InputValue, right=OtherValue)
    return consumer(first, right=second)
`;

const MISSING_ARGUMENT_SOURCE = `from src.grove import node_tree

def consumer(left, right):
    return left

@node_tree(id="missing-argument", target="geometry")
def root(SeedValue):
    result = consumer(SeedValue)
    return result
`;

const INCOMPATIBLE_RETURNS_SOURCE = `from src.grove import node_tree

def choose(primary, alternate, flag):
    if flag:
        return primary
    return alternate

@node_tree(id="incompatible-returns", target="geometry")
def root(SeedValue, AlternateValue, FlagValue):
    result = choose(SeedValue, AlternateValue, FlagValue)
    return result
`;

const REASSIGNMENT_SOURCE = `from src.grove import node_tree

@node_tree(id="reassignment", target="geometry")
def root(SeedValue):
    result = SeedValue
    result = SeedValue
    return result
`;

const BRANCH_SOURCE = `from src.grove import node_tree

@node_tree(id="branch", target="geometry")
def root(SeedValue):
    if SeedValue:
        result = SeedValue
    return result
`;

const STARRED_SOURCE = `from src.grove import node_tree

@node_tree(id="starred", target="geometry")
def root(SeedValue):
    first, *rest = SeedValue
    return first
`;

const PARTIAL_SOURCE = `from src.grove import node_tree

@node_tree(id="partial", target="geometry")
def root(SeedValue):
    first, (second, third) = SeedValue
    return first
`;

const UNSUPPORTED_ZONE_SOURCE = `from src.grove import foreach_zone, node_tree

@node_tree(id="unsupported-zone", target="geometry")
def root(SeedValue):
    @foreach_zone
    def each(state):
        return state
    result = each(SeedValue)
    return result
`;

const AMBIGUOUS_ZONE_SOURCE = `from src.grove import node_tree, repeat_zone, simulation_zone

@node_tree(id="ambiguous-zone", target="geometry")
def root(SeedValue):
    @repeat_zone(iterations=2)
    @simulation_zone
    def mixed(state, index):
        return state
    result = mixed(SeedValue)
    return result
`;

const INVALID_REPEAT_INDEX_SOURCE = `from src.grove import node_tree, repeat_zone

@node_tree(id="invalid-repeat-index", target="geometry")
def root(SeedValue):
    @repeat_zone(iterations=2)
    def solve(index, state):
        return state
    result = solve(SeedValue)
    return result
`;

const IMPLICIT_REPEAT_STATE_SOURCE = `from src.grove import node_tree, repeat_zone

@node_tree(id="implicit-repeat-state", target="geometry")
def root(SeedValue):
    @repeat_zone(iterations=2)
    def solve(state):
        next_state = state
        return next_state
    result = solve(SeedValue)
    return result
`;

const TYPED_PARAMETER_SOURCE = `from src.grove import node_tree
from src.grove.types import Float

def producer(value: Float, scale: Float = 1.0) -> Float:
    result = value
    return result

@node_tree(id="typed-parameters", target="geometry")
def root(InputValue: Float) -> Float:
    output = producer(value=InputValue)
    return output
`;

const COMMENTED_PARAMETER_SOURCE = `from src.grove import node_tree

@node_tree(id="commented-parameters", target="geometry")
def root(
    SeedValue: Float,
    # A comment between parameters is legal restricted Python and must not
    # turn into a dataflow rejection.
    ResultValue: Float = 1.0,
) -> Float:
    result = SeedValue
    return result
`;

const K2_BOUNDARY_SOURCE = `from src.grove import node_tree, repeat_zone, simulation_zone

def validate(FlatTop, MaxRise):
    return FlatTop

def emit(front, cap, active):
    return front

@node_tree(id="k2-boundary", target="geometry")
def roof(
    FlatTop: Boolean = False,
    # Keep comments in the real roof signature: tree-sitter exposes them as
    # named parameter children, but they are not parameters.
    MaxRise: Float = 1.0,
):
    w8_bad = validate(FlatTop, MaxRise)
    w8_all = boolean_math(boolean=w8_bad, boolean_001=FlatTop)
    t_cap = math(value=MaxRise)

    @repeat_zone(iterations=4)
    def solve(front: Geometry, capped: Boolean, index: Integer):
        cap_now = compare(a=t_cap, b=MaxRise)
        next_capped = boolean_math(boolean=capped, boolean_001=cap_now)

        @simulation_zone
        def state(front: Geometry, active: Boolean):
            return front, active

        state_front, state_active = state(front, next_capped)
        return state_front, state_active

    front_end, capped_end = solve(w8_all, False)
    result = emit(front=front_end, cap=t_cap, active=capped_end)
    return result
`;

const AMBIGUOUS_SEED_SOURCE = `from src.grove import node_tree

@node_tree(id="first", target="geometry")
def first(SeedValue):
    first_result = SeedValue
    return first_result

@node_tree(id="second", target="geometry")
def second(SeedValue):
    second_result = SeedValue
    return second_result
`;

const LONG_CHAIN_NAMES = Array.from({ length: 20 }, (_value, index) => `stage_${String(index + 1).padStart(2, '0')}`);
const LONG_GROVE_SOURCE = `from src.grove import node_tree

@node_tree(id="long-chain", target="geometry")
def root(SeedValue):
${LONG_CHAIN_NAMES.map((name, index) => `    ${name} = ${index === 0 ? 'SeedValue' : LONG_CHAIN_NAMES[index - 1]}`).join('\n')}
    return ${LONG_CHAIN_NAMES.at(-1)}
${Array.from({ length: 2100 }, (_value, index) => `# filler ${index}`).join('\n')}
`;

const COMPOSITE_RETURN_SOURCE = `from src.grove import node_tree

def producer(first, second, third):
    return combine(first, second, third), second

@node_tree(id="composite-return", target="geometry")
def root(FirstValue, SecondValue, ThirdValue):
    combined, passthrough = producer(FirstValue, SecondValue, ThirdValue)
    return combined
`;

const RETURN_ARITY_SOURCE = `from src.grove import node_tree

def producer(value):
    return value, value

@node_tree(id="return-arity", target="geometry")
def root(SeedValue):
    first, second, third = producer(SeedValue)
    return first
`;

// Grove emits panel groups wrapped in `with frame("..."):`. A `with` body runs
// exactly once, so its assignments are unconditional dataflow, unlike `if`/`for`.
const WITH_FRAME_SOURCE = `from grove import node_tree, frame
from grove.geo import combine_xyz, curve_primitive_line, store_named_attribute

@node_tree(id="with-frame", target="geometry")
def root(tree_height):
    with frame("Trunk"):
        n_combine_xyz = combine_xyz(z=tree_height)
        curve_line = curve_primitive_line(end=n_combine_xyz)
        with frame("Nested"):
            nested_line = store_named_attribute(geometry=curve_line)
    return nested_line
`;

// Control: a real branch stays a branch even in a file that also uses frames.
const BRANCH_CONTROL_SOURCE = `from grove import node_tree, frame

@node_tree(id="branch-control", target="geometry")
def root(SeedValue, Toggle):
    with frame("Trunk"):
        framed = SeedValue
    if Toggle:
        conditional = framed
    for item in Toggle:
        looped = framed
    return framed
`;

// Grove emits `linked_defaults={...}` as call-site provenance metadata on
// nearly every generated call. It never names a declared parameter.
const LINKED_DEFAULTS_SOURCE = `from grove import node_tree

def branch_distortion(curve, resolution_length, noise_scale):
    return curve

@node_tree(id="linked-defaults", target="geometry")
def root(SeedGeometry, ResolutionLength, NoiseScale):
    group_003 = branch_distortion(curve=SeedGeometry, resolution_length=ResolutionLength, noise_scale=NoiseScale, linked_defaults={"resolution_length": 0.03})
    return group_003
`;

const UNKNOWN_KEYWORD_SOURCE = `from grove import node_tree

def branch_distortion(curve, resolution_length):
    return curve

@node_tree(id="unknown-keyword", target="geometry")
def root(SeedGeometry, ResolutionLength):
    group_003 = branch_distortion(curve=SeedGeometry, resolution_length=ResolutionLength, unknown_socket=1.0)
    return group_003
`;

const DUPLICATE_KEYWORD_SOURCE = `from grove import node_tree

def branch_distortion(curve, resolution_length):
    return curve

@node_tree(id="duplicate-keyword", target="geometry")
def root(SeedGeometry, ResolutionLength):
    group_003 = branch_distortion(SeedGeometry, curve=SeedGeometry, resolution_length=ResolutionLength, linked_defaults={"resolution_length": 0.03})
    return group_003
`;

const LINKED_DEFAULTS_ARITY_SOURCE = `from grove import node_tree

def branch_distortion(curve, resolution_length, noise_scale):
    return curve

@node_tree(id="linked-defaults-arity", target="geometry")
def root(SeedGeometry, ResolutionLength):
    group_003 = branch_distortion(curve=SeedGeometry, resolution_length=ResolutionLength, linked_defaults={"noise_scale": 0.66})
    return group_003
`;

async function analyze(source: string, filePath: string, query: string, seeds: string[]) {
  return await buildGroveEphemeralDataflow(source, filePath, query, seeds, 64);
}

describe('query-time Grove analyzer contract', () => {
  it('loads the Python grammar in a fresh query-only process', async () => {
    const result = await analyze(
      PIPELINE_SOURCE,
      'pipeline.grove.py',
      'trace Threshold through producer and consumer',
      ['Threshold'],
    );

    expect(result.text).toContain('RET producer[1] -> cap');
  });

  it('maps exact positional and keyword arguments and ordinary return positions', async () => {
    const result = await analyze(
      POSITIONAL_KEYWORD_SOURCE,
      'positional-keyword.grove.py',
      'trace InputValue OtherValue producer consumer first second',
      ['InputValue', 'OtherValue'],
    );

    expect(result.text).toContain('ARG InputValue -> producer.left');
    expect(result.text).toContain('ARG OtherValue -> producer.right');
    expect(result.text).toContain('RET producer[0] -> first');
    expect(result.text).toContain('RET producer[1] -> second');
    expect(result.text).toContain('ARG first -> consumer.left');
    expect(result.text).toContain('ARG second -> consumer.right');
  });

  it('maps typed and typed-default Grove parameters', async () => {
    const result = await analyze(
      TYPED_PARAMETER_SOURCE,
      'typed-parameters.grove.py',
      'trace InputValue producer output',
      ['InputValue'],
    );

    expect(result.text).toContain('ARG InputValue -> producer.value');
    expect(result.text).toContain('RET producer[0] -> output');
    expect(result.text).not.toContain('unsupported parameter form');
  });

  it('ignores comments embedded in a function parameter list', async () => {
    const result = await analyze(
      COMMENTED_PARAMETER_SOURCE,
      'commented-parameters.grove.py',
      'trace SeedValue through root to result',
      ['SeedValue'],
    );

    expect(result.text).toContain('SeedValue -> result');
    expect(result.text).not.toContain('unsupported parameter form');
  });

  it('keeps ordinary-call returns and nested zone state in one bounded K2 slice', async () => {
    const result = await analyze(
      K2_BOUNDARY_SOURCE,
      'k2-boundary.grove.py',
      'trace FlatTop MaxRise through validate w8_bad w8_all t_cap solve next_capped state state_active capped_end emit',
      ['FlatTop', 'MaxRise'],
    );

    for (const fact of [
      'ARG FlatTop -> validate.FlatTop',
      'RET validate[0] -> w8_bad',
      'w8_bad -> w8_all',
      'ZONE solve kind=repeat state-arity=2 owner=roof',
      'ZONE state kind=simulation state-arity=2 owner=roof::solve',
      'ARG next_capped -> state.active',
      'RET state[1] -> state_active',
      'RET solve[1] -> capped_end',
      'ARG capped_end -> emit.active',
      'ARG t_cap -> emit.cap',
    ]) {
      expect(result.text).toContain(fact);
    }
    expect(result.text).not.toContain('state-arity=3');
    expect((result.text.match(/^- /gm) ?? []).length).toBeLessThanOrEqual(64);
    expect(result.text).toMatch(/k2-boundary\.grove\.py:\d+/);
  });

  it('fails closed when an unqualified seed exists in disconnected sibling scopes', async () => {
    const result = await analyze(
      AMBIGUOUS_SEED_SOURCE,
      'ambiguous-seed.grove.py',
      'trace SeedValue',
      ['SeedValue'],
    );

    expect(result.text).toContain('REJECTED: ambiguous seed SeedValue across scopes first, second');
    expect(result.text).not.toContain('SeedValue -> first_result');
    expect(result.text).not.toContain('SeedValue -> second_result');
  });

  it('renders one fact per exact return position even when its expression has several dependencies', async () => {
    const result = await analyze(
      COMPOSITE_RETURN_SOURCE,
      'composite-return.grove.py',
      'trace FirstValue SecondValue ThirdValue producer combined',
      ['FirstValue', 'SecondValue', 'ThirdValue'],
    );

    expect((result.text.match(/RET producer\[0\] -> combined/g) ?? []).length).toBe(1);
  });

  it('fails closed on tuple return arity mismatch', async () => {
    const result = await analyze(
      RETURN_ARITY_SOURCE,
      'return-arity.grove.py',
      'trace SeedValue producer first second third',
      ['SeedValue'],
    );

    expect(result.text).toContain('REJECTED: return arity mismatch from producer');
    expect(result.text).not.toContain('RET producer[0] -> first');
  });

  it('fails closed on an ordinary call arity mismatch', async () => {
    const result = await analyze(
      MISSING_ARGUMENT_SOURCE,
      'missing-argument.grove.py',
      'trace SeedValue consumer result',
      ['SeedValue'],
    );

    expect(result.text).toContain('REJECTED: argument arity mismatch calling consumer');
    expect(result.text).not.toContain('ARG SeedValue -> consumer.left');
    expect(result.text).toMatch(/missing-argument\.grove\.py:\d+/);
  });

  it('fails closed instead of fabricating a wire through incompatible returns', async () => {
    const result = await analyze(
      INCOMPATIBLE_RETURNS_SOURCE,
      'incompatible-returns.grove.py',
      'trace SeedValue AlternateValue FlagValue choose result',
      ['SeedValue', 'AlternateValue', 'FlagValue'],
    );

    expect(result.text).toContain('REJECTED: incompatible multiple returns from choose');
    expect(result.text).not.toContain('SeedValue -> result');
    expect(result.text).toMatch(/incompatible-returns\.grove\.py:\d+/);
  });

  it.each([
    ['reassignment', REASSIGNMENT_SOURCE, 'reassignment of result is ambiguous'],
    ['branch assignment', BRANCH_SOURCE, 'branch assignment of result is unsupported'],
    ['starred destructuring', STARRED_SOURCE, 'starred or partial destructuring is unsupported'],
    ['partial destructuring', PARTIAL_SOURCE, 'starred or partial destructuring is unsupported'],
  ])('fails closed with a line for %s', async (_name, source, reason) => {
    const filePath = `${_name.toString().replace(/\s+/g, '-')}.grove.py`;
    const result = await analyze(source, filePath, 'trace SeedValue result first', ['SeedValue']);

    expect(result.text).toContain(`REJECTED: ${reason}`);
    expect(result.text).toMatch(new RegExp(`${filePath.replace(/\./g, '\\.')}:\\d+`));
  });

  it.each([
    ['foreach', UNSUPPORTED_ZONE_SOURCE, 'unsupported foreach zone each'],
    ['ambiguous decorators', AMBIGUOUS_ZONE_SOURCE, 'ambiguous zone decorators on mixed'],
    ['non-trailing repeat index', INVALID_REPEAT_INDEX_SOURCE, 'repeat zone solve requires a trailing implicit index parameter'],
  ])('fails closed on %s', async (_name, source, reason) => {
    const result = await analyze(source, 'unsupported-zone.grove.py', 'trace SeedValue result zone', ['SeedValue']);

    expect(result.text).toContain(`REJECTED: ${reason}`);
    expect(result.text).not.toContain('ZONE ');
    expect(result.text).toMatch(/unsupported-zone\.grove\.py:\d+/);
  });

  it('accepts a repeat zone whose implicit index is not spelled in the function signature', async () => {
    const result = await analyze(
      IMPLICIT_REPEAT_STATE_SOURCE,
      'implicit-repeat-state.grove.py',
      'trace SeedValue through solve state result',
      ['SeedValue'],
    );

    expect(result.text).toContain('ZONE solve kind=repeat state-arity=1');
    expect(result.text).not.toContain('requires a trailing implicit index parameter');
  });
  it('keeps assignments inside Grove `with frame(...)` blocks as unconditional wires', async () => {
    const result = await analyze(
      WITH_FRAME_SOURCE,
      'with-frame.grove.py',
      'trace tree_height through n_combine_xyz curve_line nested_line',
      ['tree_height'],
    );

    expect(result.text).toContain('tree_height -> n_combine_xyz');
    expect(result.text).toContain('n_combine_xyz -> curve_line');
    expect(result.text).toContain('curve_line -> nested_line');
    expect(result.text).not.toContain('branch assignment');
  });

  it('still rejects genuine conditional and loop assignments in a framed file', async () => {
    const result = await analyze(
      BRANCH_CONTROL_SOURCE,
      'branch-control.grove.py',
      'trace SeedValue through framed conditional looped',
      ['SeedValue'],
    );

    expect(result.text).toContain('SeedValue -> framed');
    expect(result.text).toContain('REJECTED: branch assignment of conditional is unsupported');
    expect(result.text).toContain('REJECTED: branch assignment of looped is unsupported');
  });

  it('ignores Grove `linked_defaults=` call metadata while mapping every declared argument', async () => {
    const result = await analyze(
      LINKED_DEFAULTS_SOURCE,
      'linked-defaults.grove.py',
      'trace SeedGeometry ResolutionLength NoiseScale through branch_distortion group_003',
      ['SeedGeometry', 'ResolutionLength', 'NoiseScale'],
    );

    expect(result.text).toContain('ARG SeedGeometry -> branch_distortion.curve');
    expect(result.text).toContain('ARG ResolutionLength -> branch_distortion.resolution_length');
    expect(result.text).toContain('ARG NoiseScale -> branch_distortion.noise_scale');
    expect(result.text).toContain('RET branch_distortion[0] -> group_003');
    expect(result.text).not.toContain('unknown or duplicate keyword argument');
    expect(result.text).not.toContain('linked_defaults');
  });

  it('still fails closed on an unknown non-Grove keyword argument', async () => {
    const result = await analyze(
      UNKNOWN_KEYWORD_SOURCE,
      'unknown-keyword.grove.py',
      'trace SeedGeometry ResolutionLength through branch_distortion group_003',
      ['SeedGeometry', 'ResolutionLength'],
    );

    expect(result.text).toContain('REJECTED: unknown or duplicate keyword argument in branch_distortion');
    expect(result.text).not.toContain('ARG SeedGeometry -> branch_distortion.curve');
  });

  it('still fails closed on a duplicate argument even when `linked_defaults=` is present', async () => {
    const result = await analyze(
      DUPLICATE_KEYWORD_SOURCE,
      'duplicate-keyword.grove.py',
      'trace SeedGeometry ResolutionLength through branch_distortion group_003',
      ['SeedGeometry', 'ResolutionLength'],
    );

    expect(result.text).toContain('REJECTED: duplicate argument curve calling branch_distortion');
    expect(result.text).not.toContain('ARG ResolutionLength -> branch_distortion.resolution_length');
  });

  it('still fails closed on an arity mismatch that `linked_defaults=` does not satisfy', async () => {
    const result = await analyze(
      LINKED_DEFAULTS_ARITY_SOURCE,
      'linked-defaults-arity.grove.py',
      'trace SeedGeometry ResolutionLength through branch_distortion group_003',
      ['SeedGeometry', 'ResolutionLength'],
    );

    expect(result.text).toContain('REJECTED: argument arity mismatch calling branch_distortion');
    expect(result.text).not.toContain('ARG SeedGeometry -> branch_distortion.curve');
  });
  it('selects the same K2 facts regardless of the prose phrase used for the gate', async () => {
    const seeds = ['FlatTop', 'MaxRise'];
    const base =
      'In exact file k2-boundary.grove.py trace FlatTop and MaxRise through code-8 validation, ' +
      't_cap, the nested solve %PHRASE%, capped tuple state, and the sole emit call.';
    const gate = await buildGroveEphemeralDataflow(
      K2_BOUNDARY_SOURCE, 'k2-boundary.grove.py', base.replace('%PHRASE%', 'cap gate'), seeds, 16,
    );
    const threshold = await buildGroveEphemeralDataflow(
      K2_BOUNDARY_SOURCE, 'k2-boundary.grove.py', base.replace('%PHRASE%', 'cap threshold'), seeds, 16,
    );

    // Ranking must be driven by the identifiers a query names, never by one
    // fixture's prose wording. Two synonyms that name no new identifier must
    // select the same bounded slice.
    expect(gate.text).toBe(threshold.text);
  });

  it('does not give an arbitrary skel_ helper prefix special ranking priority', async () => {
    const source = `from src.grove import node_tree

def other_validate(value):
    return value

def skel_validate(value):
    return value

@node_tree(id="prefix-neutral", target="geometry")
def prefix_neutral(SeedValue):
    other_result = other_validate(SeedValue)
    skel_result = skel_validate(SeedValue)
    return other_result
`;
    const result = await buildGroveEphemeralDataflow(
      source,
      'prefix-neutral.grove.py',
      'trace SeedValue through validate',
      ['SeedValue'],
      1,
    );

    expect(result.text).toContain('ARG SeedValue -> other_validate.value');
    expect(result.text).not.toContain('ARG SeedValue -> skel_validate.value');
  });

  it('selects the required K2 tuple and zone facts from a generic identifier query', async () => {
    const result = await analyze(
      K2_BOUNDARY_SOURCE,
      'k2-boundary.grove.py',
      'In exact file k2-boundary.grove.py trace FlatTop and MaxRise through validate, t_cap, ' +
        'cap_now, next_capped, the nested solve and state zones, capped_end and emit.',
      ['FlatTop', 'MaxRise'],
    );

    for (const fact of [
      'RET validate[0] -> w8_bad',
      'w8_bad -> w8_all',
      'MaxRise -> t_cap',
      'ZONE solve kind=repeat state-arity=2 owner=roof',
      'ZONE state kind=simulation state-arity=2 owner=roof::solve',
      'cap_now -> next_capped',
      'ARG next_capped -> state.active',
      'RET solve[1] -> capped_end',
      'ARG capped_end -> emit.active',
      'ARG t_cap -> emit.cap',
    ]) {
      expect(result.text).toContain(fact);
    }
  });
});

// The C1 matrix classified the large BNO exact query EXPLICITLY_INCOMPLETE: the
// only precise identifier in the query (`skel_cap_emit`) names a function, so
// the analyzer found no value roots and silently omitted the Dataflow surface.
// These tests pin the repaired contract: the boundary facts are attributable,
// zone ownership stays distinct, and any unresolvable slice says why.
describe('C1-reproduced semantic gaps', () => {
  const BNO_LARGE_PATH = path.join(__dirname, 'fixtures', 'grove', 'rung3b.grove.py');

  it('returns attributable call-boundary tuple facts and zone ownership on the exact BNO file', async () => {
    const content = fs.readFileSync(BNO_LARGE_PATH, 'utf-8');
    // LF-normalized hash of the frozen BNO file (raw mixed-ending bytes hash
    // c52a956b2a3df494f169c20687944e1d3cc4f23a1fa20f956e147cd623b69964, per
    // the C1 matrix). Normalized so the pin survives an autocrlf checkout.
    expect(createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex'))
      .toBe('229587eb373b6659702ecf55ea84735800a7c62b75e5a036d5eb467f3ed353cc');
    const result = await buildGroveEphemeralDataflow(
      content,
      'rung3b.grove.py',
      'trace the current roof to solve to skel_cap_emit dependency and tuple flow, including zone ' +
        'ownership. Do not substitute a same-named group from another file.',
      ['skel_cap_emit'],
      64,
    );

    expect(result.factCount).toBeGreaterThan(0);
    expect(result.text).toContain('ARG capped_end -> skel_cap_emit.active');
    expect(result.text).toContain('RET skel_cap_emit[0] -> cap_arcs');
    expect(result.text).toContain('RET solve[8] -> capped_end');
    expect(result.text).toContain('ZONE solve kind=repeat state-arity=9 owner=roof');
    expect(result.text).not.toContain('ZONE solve kind=simulation');
  });

  it('anchors Repeat versus Simulation ownership from a function-name seed without mixing kinds', async () => {
    const result = await buildGroveEphemeralDataflow(
      ZONE_SOURCE,
      'zones.grove.py',
      'trace skel_cap_emit tuple flow including nested zone ownership',
      ['skel_cap_emit'],
      64,
    );

    expect(result.factCount).toBeGreaterThan(0);
    expect(result.text).toContain('ZONE solve kind=repeat state-arity=2 owner=roof');
    expect(result.text).toContain('ZONE state kind=simulation state-arity=2 owner=roof::solve');
    expect(result.text).toContain('ARG capped_end -> skel_cap_emit.active');
    expect(result.text).not.toContain('ZONE solve kind=simulation');
    expect(result.text).not.toContain('ZONE state kind=repeat');
  });

  it('returns an explicit bounded-incomplete reason when a function seed names an unsupported zone', async () => {
    const result = await buildGroveEphemeralDataflow(
      UNSUPPORTED_ZONE_SOURCE,
      'unsupported-zone.grove.py',
      'trace each zone ownership',
      ['each'],
      64,
    );

    expect(result.factCount).toBeGreaterThan(0);
    expect(result.text).toContain('REJECTED: unsupported foreach zone each');
    expect(result.text).not.toContain('ZONE ');
  });

  it('says why the slice is incomplete instead of silently omitting the Dataflow surface', async () => {
    const result = await buildGroveEphemeralDataflow(
      PIPELINE_SOURCE,
      'pipeline.grove.py',
      'trace NothingMatching anywhere',
      ['NothingMatching'],
      64,
    );

    expect(result.factCount).toBeGreaterThan(0);
    expect(result.text).toContain('INCOMPLETE: no value binding or function boundary in this file matches');
  });
});

describe('query-time Grove ephemeral dataflow', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-grove-ephemeral-dataflow-'));
    fs.writeFileSync(path.join(testDir, 'pipeline.grove.py'), PIPELINE_SOURCE);
    fs.writeFileSync(path.join(testDir, 'zones.grove.py'), ZONE_SOURCE);
    fs.writeFileSync(path.join(testDir, 'ingested.grove.py'), INGESTED_SOURCE);
    fs.writeFileSync(path.join(testDir, 'pipeline-snapshot.grove.py'), SNAPSHOT_SOURCE);
    fs.writeFileSync(path.join(testDir, 'ordinary.py'), NON_GROVE_SOURCE);
    fs.writeFileSync(path.join(testDir, 'long-chain.grove.py'), LONG_GROVE_SOURCE);
    fs.writeFileSync(path.join(testDir, 'k2-boundary.grove.py'), K2_BOUNDARY_SOURCE);
    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    cg?.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('renders bounded exact-file tuple and ordinary-call bindings on demand', async () => {
    const result = await handler.execute('codegraph_explore', {
      query:
        'In exact file pipeline.grove.py trace Threshold through producer and root into ' +
        'consumer, including tuple return positions and keyword arguments.',
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('**Dataflow (within `pipeline.grove.py`, direct wires only)**');
    expect(text).toContain('Threshold -> producer.Threshold');
    expect(text).toContain('RET producer[1] -> cap');
    expect(text).toContain('ARG cap -> consumer.cap');
    expect(text).not.toContain('pipeline-snapshot.grove.py');
    expect((text.match(/^- /gm) ?? []).length).toBeLessThanOrEqual(16);
  });

  it('renders Repeat and Simulation Zone ownership with the implicit index excluded', async () => {
    const result = await handler.execute('codegraph_explore', {
      query:
        'In exact file zones.grove.py trace FlatTop MaxRise through roof solve and ' +
        'skel_cap_emit, including nested Repeat Zone and Simulation Zone tuple state.',
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('**Dataflow (within `zones.grove.py`, direct wires only)**');
    expect(text).toContain('ZONE solve kind=repeat state-arity=2');
    expect(text).toContain('ZONE state kind=simulation state-arity=2');
    expect(text).toContain('RET solve[1] -> capped_end');
    expect(text).toContain('ARG capped_end -> skel_cap_emit.active');
    expect(text).not.toContain('state-arity=3');
    expect((text.match(/^- /gm) ?? []).length).toBeLessThanOrEqual(32);
  });

  it('accepts an ingested-source-shaped decorator without changing resolver extraction', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'In exact file ingested.grove.py trace InputValue to doubled and ingested.',
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).toContain('**Dataflow (within `ingested.grove.py`, direct wires only)**');
    expect(text).toContain('InputValue -> doubled');
    expect(text).not.toContain('interface_order is unsupported');
  });

  it('preserves exact-file behavior for non-Grove Python', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'In exact file ordinary.py trace InputValue to doubled.',
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).not.toContain('**Dataflow (within');
    expect(text).toContain('ordinary.py');
  });

  it('preserves unpinned Grove exploration behavior', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'trace Threshold through producer and consumer',
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';

    expect(text).not.toContain('**Dataflow (within');
  });

  it('uses the large-file ceiling without dropping a requested direct-wire chain', async () => {
    const result = await handler.execute('codegraph_explore', {
      query:
        `In exact file long-chain.grove.py trace SeedValue through root ${LONG_CHAIN_NAMES.join(' ')}.`,
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';
    const dataflowText = text.split('**Exploration:', 1)[0] ?? '';
    const bullets = dataflowText.match(/^- /gm) ?? [];

    expect(dataflowText).toContain(`${LONG_CHAIN_NAMES.at(-2)} -> ${LONG_CHAIN_NAMES.at(-1)}`);
    expect(bullets.length).toBe(20);
    expect(bullets.length).toBeLessThanOrEqual(64);
  });

  it('assembles disconnected validation and sink boundaries into the exact-file K2 result', async () => {
    const result = await handler.execute('codegraph_explore', {
      query:
        'In exact file k2-boundary.grove.py trace FlatTop and MaxRise through code-8 validation, ' +
        't_cap, the nested solve threshold, capped tuple state, and the sole emit call.',
      maxFiles: 4,
    });
    const text = result.content?.[0]?.text ?? '';

    for (const fact of [
      'RET validate[0] -> w8_bad',
      'w8_bad -> w8_all',
      'RET solve[1] -> capped_end',
      'ARG capped_end -> emit.active',
    ]) {
      expect(text).toContain(fact);
    }
    expect((text.match(/^- /gm) ?? []).length).toBeLessThanOrEqual(64);
    expect(text).not.toContain('pipeline-snapshot.grove.py');
  });
});
