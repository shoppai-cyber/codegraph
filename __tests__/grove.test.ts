import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getParser, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { getFrameworkResolver } from '../src/resolution/frameworks';
import { groveResolver } from '../src/resolution/frameworks/grove';
import type { ResolutionContext } from '../src/resolution/types';

function decodedGroveReference(referenceName: string): {
  qualifiedName: string;
  startLine?: number;
} {
  const marker = '_ref__';
  const markerIndex = referenceName.indexOf(marker);
  if (markerIndex < 0) throw new Error(`not a Grove reference: ${referenceName}`);
  return JSON.parse(
    Buffer.from(referenceName.slice(markerIndex + marker.length), 'base64url').toString('utf8')
  );
}

beforeAll(async () => {
  await loadGrammarsForLanguages(['python']);
});

describe('Grove framework resolver', () => {
  it('is registered for Grove source extraction', () => {
    expect(getFrameworkResolver('grove')?.name).toBe('grove');
  });

  it('detects a Grove import after the first 100 Python files', () => {
    const groveFile = 'graphs/late.grove.py';
    const files = [
      ...Array.from({ length: 120 }, (_, index) => `pkg/module_${index}.py`),
      groveFile,
    ];
    const context = {
      getAllFiles: () => files,
      readFile: (filePath: string) =>
        filePath === groveFile
          ? 'from src.grove import (\n    node_tree as nt,\n)\n'
          : 'VALUE = 1\n',
    } as ResolutionContext;

    expect(groveResolver.detect(context)).toBe(true);
  });

  it('does not detect a Grove import written only inside a string', () => {
    const filePath = 'examples/fake.py';
    const context = {
      getAllFiles: () => [filePath],
      readFile: () => `EXAMPLE = """
from src.grove import node_tree
@node_tree(id="fake.v1", target="geometry")
"""
`,
    } as ResolutionContext;

    expect(groveResolver.detect(context)).toBe(false);
  });

  it('detects a backslash-continued Grove import', () => {
    const filePath = 'graphs/continued.grove.py';
    const context = {
      getAllFiles: () => [filePath],
      readFile: () => 'from src.grove import \\\n    node_tree as nt\n',
    } as ResolutionContext;

    expect(groveResolver.detect(context)).toBe(true);
  });

  it('deletes its secondary Python syntax tree after extraction', () => {
    const parser = getParser('python');
    expect(parser).toBeDefined();
    const originalParse = parser!.parse.bind(parser);
    let deleteCalls = 0;
    const parseSpy = vi.spyOn(parser!, 'parse').mockImplementation(((...args: unknown[]) => {
      const tree = originalParse(...(args as Parameters<typeof originalParse>));
      const originalDelete = tree.delete.bind(tree);
      Object.defineProperty(tree, 'delete', {
        configurable: true,
        value: () => {
          deleteCalls++;
          originalDelete();
        },
      });
      return tree;
    }) as typeof parser.parse);

    try {
      groveResolver.extract?.(
        'graphs/tree-lifecycle.grove.py',
        `from src.grove import node_tree

@node_tree(id="clean.lifecycle.v1", target="geometry")
def lifecycle(geometry: Geometry) -> Geometry:
    return geometry
`
      );
    } finally {
      parseSpy.mockRestore();
    }

    expect(deleteCalls).toBe(1);
  });

  it('extracts a group whose node_tree decorator spans multiple lines', () => {
    const result = groveResolver.extract?.(
      'graphs/branch.grove.py',
      `from src.grove import node_tree

@node_tree(
    id="clean.branch.v1",
    target="geometry",
)
def branch(geometry: Geometry) -> Geometry:
    return geometry
`
    );

    expect(
      result?.nodes.map(({ kind, name, qualifiedName, startLine, endLine }) => ({
        kind,
        name,
        qualifiedName,
        startLine,
        endLine,
      }))
    ).toEqual([
      {
        kind: 'component',
        name: 'clean.branch.v1',
        qualifiedName: 'graphs/branch.grove.py::grove:clean.branch.v1',
        startLine: 3,
        endLine: 7,
      },
    ]);
  });

  it('keeps a multiline group component on the decorator and function header', () => {
    const result = groveResolver.extract?.(
      'graphs/envelope.grove.py',
      `from src.grove import node_tree

@node_tree(
    id="clean.envelope.v1",
    target="geometry",
)
def envelope(
    geometry: Geometry,
) -> Geometry:
    first = geometry
    second = first
    third = second
    fourth = third
    fifth = fourth
    sixth = fifth
    seventh = sixth
    eighth = seventh
    return eighth
`
    );

    expect(
      result?.nodes.map(({ name, startLine, endLine }) => ({ name, startLine, endLine }))
    ).toEqual([
      {
        name: 'clean.envelope.v1',
        startLine: 3,
        endLine: 9,
      },
    ]);
  });

  it('links a Grove group call to the callee group identity', () => {
    const result = groveResolver.extract?.(
      'graphs/root.grove.py',
      `from grove import node_tree

@node_tree(id="clean.helper.v1", target="geometry")
def helper(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.root.v1", target="geometry")
def root(geometry: Geometry) -> Geometry:
    return helper(geometry)
`
    );

    const groupNameByNodeId = new Map(
      result?.nodes.map((node) => [node.id, node.name])
    );
    const groupNameByQualifiedName = new Map(
      result?.nodes.map((node) => [node.qualifiedName, node.name])
    );
    expect(
      result?.references
        .filter((ref) => ref.referenceKind === 'calls')
        .map(({ fromNodeId, referenceName, referenceKind, line }) => ({
          fromGroup: groupNameByNodeId.get(fromNodeId),
          referenceName: groupNameByQualifiedName.get(
            decodedGroveReference(referenceName).qualifiedName
          ),
          referenceKind,
          line,
        }))
    ).toEqual([
      {
        fromGroup: 'clean.root.v1',
        referenceName: 'clean.helper.v1',
        referenceKind: 'calls',
        line: 9,
      },
    ]);
  });

  it('preserves one Grove call reference per source site', () => {
    const result = groveResolver.extract?.(
      'graphs/call-sites.grove.py',
      `from src.grove import node_tree

@node_tree(id="clean.helper.v1", target="geometry")
def helper(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.root.v1", target="geometry")
def root(geometry: Geometry) -> Geometry:
    first = helper(geometry)
    return helper(first)
`
    );

    expect(
      result?.references
        .filter((ref) => ref.referenceKind === 'calls')
        .map((ref) => ({
          target: decodedGroveReference(ref.referenceName).qualifiedName,
          line: ref.line,
        }))
    ).toEqual([
      {
        target: 'graphs/call-sites.grove.py::grove:clean.helper.v1',
        line: 9,
      },
      {
        target: 'graphs/call-sites.grove.py::grove:clean.helper.v1',
        line: 10,
      },
    ]);
  });

  it('does not attribute an ordinary top-level helper call to the preceding group', () => {
    const result = groveResolver.extract?.(
      'graphs/helpers.grove.py',
      `from src.grove import node_tree

@node_tree(id="clean.source.v1", target="geometry")
def source(geometry: Geometry) -> Geometry:
    return geometry

def ordinary_helper(geometry: Geometry) -> Geometry:
    return target(geometry)

@node_tree(id="clean.target.v1", target="geometry")
def target(geometry: Geometry) -> Geometry:
    return geometry
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual([
      'clean.source.v1',
      'clean.target.v1',
    ]);
    expect(
      result?.references.filter(
        (ref) => ref.referenceKind === 'calls' || ref.referenceKind === 'contains'
      )
    ).toEqual([]);
  });

  it('does not extract Grove groups or calls from string contents', () => {
    const result = groveResolver.extract?.(
      'graphs/strings.grove.py',
      `from src.grove import node_tree

@node_tree(id="clean.root.v1", target="geometry")
def root(geometry: Geometry) -> Geometry:
    """@node_tree(id="fake.group.v1")
    def fake(geometry):
        return target(geometry)
    """
    example = "target(geometry)"
    return geometry

@node_tree(id="clean.target.v1", target="geometry")
def target(geometry: Geometry) -> Geometry:
    return geometry
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual([
      'clean.root.v1',
      'clean.target.v1',
    ]);
    expect(
      result?.references.filter(
        (ref) => ref.referenceKind === 'calls' || ref.referenceKind === 'contains'
      )
    ).toEqual([]);
  });

  it('does not fabricate groups or calls from class, nested, unresolved, or attribute forms', () => {
    const result = groveResolver.extract?.(
      'graphs/negative-controls.grove.py',
      `from src.grove import node_tree

class Holder:
    @node_tree(id="clean.class.v1", target="geometry")
    def class_group(self, geometry: Geometry) -> Geometry:
        return geometry

@node_tree(id="clean.root.v1", target="geometry")
def root(geometry: Geometry) -> Geometry:
    missing_group(geometry)
    namespace.helper(geometry)
    @node_tree(id="clean.nested.v1", target="geometry")
    def nested(geometry: Geometry) -> Geometry:
        return helper(geometry)
    return geometry

@node_tree(id="clean.helper.v1", target="geometry")
def helper(geometry: Geometry) -> Geometry:
    return geometry
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual([
      'clean.root.v1',
      'clean.helper.v1',
    ]);
    expect(result?.references.filter((ref) => ref.referenceKind === 'calls')).toEqual([]);
  });

  it('extracts nested zones, their ownership, and group calls inside a zone', () => {
    const filePath = 'graphs/zones.grove.py';
    const result = groveResolver.extract?.(
      filePath,
      `from src.grove import (
    node_tree as nt,
    repeat_zone as rz,
    simulation_zone,
    foreach_zone,
)

@nt(id="clean.helper.v1", target="geometry")
def helper(geometry: Geometry) -> Geometry:
    return geometry

@nt(id="clean.root.v1", target="geometry")
def root(geometry: Geometry, steps: Integer) -> Geometry:
    @rz(iterations=steps)
    def outer(geometry: Geometry) -> Geometry:
        @simulation_zone
        def simulate(geometry: Geometry) -> Geometry:
            @foreach_zone(domain="POINT", geometry=geometry)
            def each(element: Geometry) -> Geometry:
                return helper(element)
            return each()
        return simulate()
    return outer(geometry)
`
    );

    expect(result?.nodes.map(({ name, qualifiedName }) => ({ name, qualifiedName }))).toEqual([
      {
        name: 'clean.helper.v1',
        qualifiedName: `${filePath}::grove:clean.helper.v1`,
      },
      {
        name: 'clean.root.v1',
        qualifiedName: `${filePath}::grove:clean.root.v1`,
      },
      {
        name: 'outer',
        qualifiedName: `${filePath}::grove:clean.root.v1::zone:repeat:outer`,
      },
      {
        name: 'simulate',
        qualifiedName:
          `${filePath}::grove:clean.root.v1::zone:repeat:outer::simulation:simulate`,
      },
      {
        name: 'each',
        qualifiedName:
          `${filePath}::grove:clean.root.v1::zone:repeat:outer::simulation:simulate::foreach:each`,
      },
    ]);

    const nodeNameById = new Map(result?.nodes.map((node) => [node.id, node.name]));
    expect(
      result?.references
        .filter((ref) => ref.referenceKind === 'contains')
        .map((ref) => ({
          owner: nodeNameById.get(ref.fromNodeId),
          contained: decodedGroveReference(ref.referenceName).qualifiedName,
        }))
    ).toEqual([
      {
        owner: 'clean.root.v1',
        contained: `${filePath}::grove:clean.root.v1::zone:repeat:outer`,
      },
      {
        owner: 'outer',
        contained:
          `${filePath}::grove:clean.root.v1::zone:repeat:outer::simulation:simulate`,
      },
      {
        owner: 'simulate',
        contained:
          `${filePath}::grove:clean.root.v1::zone:repeat:outer::simulation:simulate::foreach:each`,
      },
    ]);
    expect(
      result?.references
        .filter((ref) => ref.referenceKind === 'calls')
        .map((ref) => ({
          caller: nodeNameById.get(ref.fromNodeId),
          callee: nodeNameById.get(
            result?.nodes.find(
              (node) =>
                node.qualifiedName ===
                decodedGroveReference(ref.referenceName).qualifiedName
            )?.id ?? ''
          ),
          line: ref.line,
        }))
    ).toEqual([
      {
        caller: 'clean.root.v1',
        callee: 'clean.helper.v1',
        line: 20,
      },
    ]);
    expect(
      result?.references
        .filter((ref) => ref.referenceKind === 'decorates')
        .map((ref) => ({
          component: nodeNameById.get(ref.fromNodeId),
          pythonFunction: decodedGroveReference(ref.referenceName).qualifiedName,
        }))
    ).toEqual([
      { component: 'clean.helper.v1', pythonFunction: 'helper' },
      { component: 'clean.root.v1', pythonFunction: 'root' },
      { component: 'outer', pythonFunction: 'root::outer' },
      { component: 'simulate', pythonFunction: 'root::outer::simulate' },
      { component: 'each', pythonFunction: 'root::outer::simulate::each' },
    ]);
  });

  it('rejects a group whose target is not a literal string', () => {
    const result = groveResolver.extract?.(
      'graphs/dynamic-target.grove.py',
      `from src.grove import node_tree

TARGET = "geometry"

@node_tree(id="clean.dynamic.v1", target=TARGET)
def dynamic_target(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.literal.v1", target="geometry")
def literal_target(geometry: Geometry) -> Geometry:
    return geometry
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual(['clean.literal.v1']);
  });

  it('rejects a node_tree function with stacked decorators', () => {
    const result = groveResolver.extract?.(
      'graphs/stacked.grove.py',
      `from src.grove import node_tree

@foreign_decorator
@node_tree(id="clean.stacked.v1", target="geometry")
def stacked(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.literal.v1", target="geometry")
def literal(geometry: Geometry) -> Geometry:
    return geometry
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual(['clean.literal.v1']);
  });

  it('suppresses every group with a duplicate id or decorated function name', () => {
    const result = groveResolver.extract?.(
      'graphs/duplicates.grove.py',
      `from src.grove import node_tree

@node_tree(id="clean.duplicate-id.v1", target="geometry")
def duplicate_id_first(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.duplicate-id.v1", target="geometry")
def duplicate_id_second(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.duplicate-name-a.v1", target="geometry")
def duplicate_name(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.duplicate-name-b.v1", target="geometry")
def duplicate_name(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.valid.v1", target="geometry")
def valid(geometry: Geometry) -> Geometry:
    return geometry
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual(['clean.valid.v1']);
  });

  it('rejects duplicate id or target keywords in node_tree', () => {
    const result = groveResolver.extract?.(
      'graphs/duplicate-keywords.grove.py',
      `from src.grove import node_tree

@node_tree(id="clean.first.v1", id="clean.second.v1", target="geometry")
def duplicate_id(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.target.v1", target="geometry", target="shader")
def duplicate_target(geometry: Geometry) -> Geometry:
    return geometry
`
    );

    expect(result?.nodes).toEqual([]);
  });

  it('rejects positional, expanded, unknown, and contract-invalid node_tree metadata', () => {
    const result = groveResolver.extract?.(
      'graphs/invalid-metadata.grove.py',
      `from src.grove import node_tree

META = {"id": "clean.expanded.v1", "target": "geometry"}

@node_tree("positional", id="clean.positional.v1", target="geometry")
def positional(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(**META)
def expanded(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.unknown.v1", target="geometry", mystery="value")
def unknown(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.bad-target.v1", target="bogus")
def bad_target(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.bad-host.v1", target="geometry", host="WORLD")
def bad_host(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.valid.v1", target="geometry", name="Valid", host="MESH")
def valid(geometry: Geometry) -> Geometry:
    return geometry
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual(['clean.valid.v1']);
  });

  it('accepts literal panels and labels metadata from the Grove contract', () => {
    const result = groveResolver.extract?.(
      'graphs/interface-metadata.grove.py',
      `from src.grove import node_tree

@node_tree(
    id="clean.interface-metadata.v1",
    target="geometry",
    labels={"scale": "Scale", "return": "Result"},
    panels={"Shape": ["scale"]},
)
def interface_metadata(geometry: Geometry, scale: Float = 1.0) -> Geometry:
    return geometry
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual([
      'clean.interface-metadata.v1',
    ]);
  });

  it('rejects computed panels and labels metadata', () => {
    const result = groveResolver.extract?.(
      'graphs/computed-interface-metadata.grove.py',
      `from src.grove import node_tree

LABELS = {"scale": "Scale"}

@node_tree(id="clean.computed-labels.v1", target="geometry", labels=LABELS)
def computed_labels(geometry: Geometry, scale: Float = 1.0) -> Geometry:
    return geometry

@node_tree(id="clean.computed-panels.v1", target="geometry", panels={"Shape": tuple(["scale"])})
def computed_panels(geometry: Geometry, scale: Float = 1.0) -> Geometry:
    return geometry
`
    );

    expect(result?.nodes).toEqual([]);
  });

  it('decodes Python string escapes before duplicate group-id suppression', () => {
    const result = groveResolver.extract?.(
      'graphs/escaped-ids.grove.py',
      String.raw`from src.grove import node_tree

@node_tree(id="clean\x2eduplicate.v1", target="geometry")
def first(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.duplicate.v1", target="geometry")
def second(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.valid.v1", target="geometry")
def valid(geometry: Geometry) -> Geometry:
    return geometry
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual(['clean.valid.v1']);
  });

  it('fails closed on named Unicode escapes in Grove identity strings', () => {
    const result = groveResolver.extract?.(
      'graphs/named-unicode-id.grove.py',
      String.raw`from src.grove import node_tree

@node_tree(id="clean\N{FULL STOP}group", target="geometry")
def named_escape(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.group", target="geometry")
def plain(geometry: Geometry) -> Geometry:
    return geometry
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual(['clean.group']);
  });

  it('does not bind a zone invocation to a shadowed top-level Grove group', () => {
    const result = groveResolver.extract?.(
      'graphs/zone-shadow.grove.py',
      `from src.grove import node_tree, repeat_zone

@node_tree(id="clean.top-level-solve.v1", target="geometry")
def solve(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.root.v1", target="geometry")
def root(geometry: Geometry, steps: Integer) -> Geometry:
    @repeat_zone(iterations=steps)
    def solve(geometry: Geometry) -> Geometry:
        return geometry
    return solve(geometry)
`
    );

    expect(result?.references.filter((ref) => ref.referenceKind === 'calls')).toEqual([]);
  });

  it('does bind a group call that shares only an ancestor zone name', () => {
    const result = groveResolver.extract?.(
      'graphs/nested-zone-shadow.grove.py',
      `from src.grove import node_tree, repeat_zone

@node_tree(id="clean.top-level-loop.v1", target="geometry")
def loop(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.root.v1", target="geometry")
def root(geometry: Geometry, steps: Integer) -> Geometry:
    @repeat_zone(iterations=steps)
    def loop(geometry: Geometry) -> Geometry:
        return loop(geometry)
    return loop(geometry)
`
    );

    const calls = result?.references.filter((ref) => ref.referenceKind === 'calls') ?? [];
    expect(calls.map((ref) => ({
      target: decodedGroveReference(ref.referenceName).qualifiedName,
      line: ref.line,
    }))).toEqual([{
      target: 'graphs/nested-zone-shadow.grove.py::grove:clean.top-level-loop.v1',
      line: 11,
    }]);
  });

  it('does not emit zones for statically invalid decorator argument shapes', () => {
    const result = groveResolver.extract?.(
      'graphs/invalid-zone-decorators.grove.py',
      `from src.grove import foreach_zone, node_tree, repeat_zone, simulation_zone

@node_tree(id="clean.root.v1", target="geometry")
def root(geometry: Geometry, steps: Integer) -> Geometry:
    @repeat_zone(steps)
    def positional_repeat(state: Geometry) -> Geometry:
        return state

    @foreach_zone()
    def empty_foreach(element: Geometry) -> Geometry:
        return element

    @simulation_zone(iterations=steps)
    def argument_simulation(state: Geometry) -> Geometry:
        return state

    return geometry
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual(['clean.root.v1']);
    expect(result?.references.filter((ref) => ref.referenceKind === 'contains')).toEqual([]);
  });

  it('keeps an invalid recognized zone binding from becoming a Grove group call', () => {
    const result = groveResolver.extract?.(
      'graphs/invalid-zone-shadow.grove.py',
      `from src.grove import node_tree, repeat_zone

@node_tree(id="clean.top-level-solve.v1", target="geometry")
def solve(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.root.v1", target="geometry")
def root(geometry: Geometry, steps: Integer) -> Geometry:
    @repeat_zone(steps)
    def solve(geometry: Geometry) -> Geometry:
        return geometry
    return solve(geometry)
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual([
      'clean.top-level-solve.v1',
      'clean.root.v1',
    ]);
    expect(result?.references.filter((ref) => ref.referenceKind === 'calls')).toEqual([]);
  });

  it('suppresses duplicate zone names within one owner scope', () => {
    const result = groveResolver.extract?.(
      'graphs/duplicate-zones.grove.py',
      `from src.grove import node_tree, repeat_zone

@node_tree(id="clean.root.v1", target="geometry")
def root(geometry: Geometry, steps: Integer) -> Geometry:
    @repeat_zone(iterations=steps)
    def solve(geometry: Geometry) -> Geometry:
        return geometry
    @repeat_zone(iterations=steps)
    def solve(geometry: Geometry) -> Geometry:
        return geometry
    return solve(geometry)
`
    );

    expect(result?.nodes.map((node) => node.name)).toEqual(['clean.root.v1']);
    expect(result?.references.filter((ref) => ref.referenceKind === 'contains')).toEqual([]);
  });

  it('keeps duplicate zone names shadowing a same-named Grove group', () => {
    const result = groveResolver.extract?.(
      'graphs/duplicate-zone-shadow.grove.py',
      `from src.grove import node_tree, repeat_zone

@node_tree(id="clean.top-level-solve.v1", target="geometry")
def solve(geometry: Geometry) -> Geometry:
    return geometry

@node_tree(id="clean.root.v1", target="geometry")
def root(geometry: Geometry, steps: Integer) -> Geometry:
    @repeat_zone(iterations=steps)
    def solve(geometry: Geometry) -> Geometry:
        return geometry
    @repeat_zone(iterations=steps)
    def solve(geometry: Geometry) -> Geometry:
        return geometry
    return solve(geometry)
`
    );

    expect(result?.references.filter((ref) => ref.referenceKind === 'calls')).toEqual([]);
  });
});
