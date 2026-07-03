/**
 * Blender framework resolver tests.
 *
 * Extraction tests call `blenderResolver.extract()` directly with inline
 * add-on sources (ported from the r1 fixture set, expectations corrected to
 * the r2 emit surface). Assertions are EXHAUSTIVE: the exact sorted node-name
 * set and the exact sorted `referenceKind:referenceName` set — a fabricated
 * extra node/reference fails the test, not just a missing one.
 *
 * Resolution tests use a mock ResolutionContext (drupal.test.ts pattern) to
 * exercise the resolve() strategies: bl_ext virtual-package-root modules,
 * host-callback method containment, and the lazy project idname index.
 */

import { describe, it, expect } from 'vitest';
import { blenderResolver } from '../src/resolution/frameworks/blender';
import type {
  FrameworkExtractionResult,
  ResolutionContext,
  UnresolvedRef,
} from '../src/resolution/types';
import type { Node } from '../src/types';

function extract(source: string, filePath = 'addon/__init__.py'): FrameworkExtractionResult {
  return blenderResolver.extract!(filePath, source);
}

function nodeNames(result: FrameworkExtractionResult): string[] {
  return result.nodes.map((n) => n.name).sort();
}

function refPairs(result: FrameworkExtractionResult): string[] {
  return result.references.map((r) => `${r.referenceKind}:${r.referenceName}`).sort();
}

function makeContext(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    ...overrides,
  };
}

function makeSymbol(
  fields: Pick<Node, 'id' | 'kind' | 'name' | 'filePath' | 'startLine' | 'endLine'>
): Node {
  return {
    qualifiedName: `${fields.filePath}::${fields.name}`,
    language: 'python',
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...fields,
  };
}

function makeRef(fields: Partial<UnresolvedRef> & Pick<UnresolvedRef, 'referenceName'>): UnresolvedRef {
  return {
    fromNodeId: 'route:test:1:x',
    referenceKind: 'references',
    line: 1,
    column: 0,
    filePath: 'addon/__init__.py',
    language: 'python',
    ...fields,
  };
}

describe('Blender Framework Resolver', () => {
  describe('extract() — registration surfaces', () => {
    it('fixture 01: registration loop over a class tuple', () => {
      const result = extract(`
import bpy


class CGB_OT_looped(bpy.types.Operator):
    bl_idname = "wm.cgb_looped"
    bl_label = "Looped registration"

    def execute(self, context):
        bpy.ops.wm.cgb_looped()
        return {'FINISHED'}


classes = (
    CGB_OT_looped,
)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)


def unregister():
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER module unregister()',
          'BLENDER register Operator CGB_OT_looped',
          'BLENDER Operator.execute CGB_OT_looped.execute',
          'BLENDER bpy-ops wm.cgb_looped',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'function_ref:unregister',
          'references:CGB_OT_looped', // register site
          'references:CGB_OT_looped', // bpy.ops call resolved to the in-file class
          'references:blender:host:CGB_OT_looped.execute',
        ].sort()
      );
    });

    it('fixture 02: assignment base aliases + Class.bl_idname argument', () => {
      const result = extract(`
import bpy

_OperatorBase = bpy.types.Operator
_PanelBase = bpy.types.Panel


class CGB_OT_alias(_OperatorBase):
    bl_idname = "wm.cgb_alias"
    bl_label = "Alias operator"

    def execute(self, context):
        return {'FINISHED'}


class CGB_PT_alias_panel(_PanelBase):
    bl_label = "Alias panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'

    def draw(self, context):
        self.layout.operator(CGB_OT_alias.bl_idname)


_REGISTER_CLASSES = (
    CGB_OT_alias,
    CGB_PT_alias_panel,
)


def register():
    for item in _REGISTER_CLASSES:
        bpy.utils.register_class(item)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER register Operator CGB_OT_alias',
          'BLENDER Operator.execute CGB_OT_alias.execute',
          'BLENDER register Panel CGB_PT_alias_panel',
          'BLENDER Panel.draw CGB_PT_alias_panel.draw',
          'BLENDER ui-operator-class-attr CGB_OT_alias',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'references:CGB_OT_alias', // register site
          'references:CGB_OT_alias', // layout.operator(CGB_OT_alias.bl_idname)
          'references:CGB_PT_alias_panel',
          'references:blender:host:CGB_OT_alias.execute',
          'references:blender:host:CGB_PT_alias_panel.draw',
        ].sort()
      );
    });

    it('from-import bases (with as-rename) + bare imported register_class', () => {
      const result = extract(`
from bpy.types import Operator, Panel as _P
from bpy.utils import register_class


class CGB_OT_fi(Operator):
    bl_idname = "wm.cgb_fi"
    bl_label = "From-import"

    def execute(self, context):
        return {'FINISHED'}


class CGB_PT_fi(_P):
    bl_label = "From-import panel"

    def draw(self, context):
        pass


def register():
    register_class(CGB_OT_fi)
    register_class(CGB_PT_fi)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER register Operator CGB_OT_fi',
          'BLENDER Operator.execute CGB_OT_fi.execute',
          'BLENDER register Panel CGB_PT_fi',
          'BLENDER Panel.draw CGB_PT_fi.draw',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'references:CGB_OT_fi',
          'references:CGB_PT_fi',
          'references:blender:host:CGB_OT_fi.execute',
          'references:blender:host:CGB_PT_fi.draw',
        ].sort()
      );
    });

    it('cross-file registration site: imported class still gets a registration node', () => {
      const result = extract(`
import bpy

from .ops import CGB_OT_remote


def register():
    bpy.utils.register_class(CGB_OT_remote)
`);
      expect(nodeNames(result)).toEqual(
        ['BLENDER module register()', 'BLENDER register CGB_OT_remote'].sort()
      );
      expect(refPairs(result)).toEqual(
        ['function_ref:register', 'references:CGB_OT_remote'].sort()
      );
    });

    it('unregistered registerable class emits nothing (base graph already has it)', () => {
      const result = extract(`
import bpy


class CGB_OT_unused(bpy.types.Operator):
    bl_idname = "wm.cgb_unused"
    bl_label = "Never registered"

    def execute(self, context):
        return {'FINISHED'}
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });
  });

  describe('extract() — idname string links', () => {
    it('fixture 03: literal idname call sites resolve to the in-file class', () => {
      const result = extract(`
import bpy


class CGB_OT_literal(bpy.types.Operator):
    bl_idname = "wm.cgb_literal"
    bl_label = "Literal idname"

    def execute(self, context):
        return {'FINISHED'}


class CGB_PT_literal_panel(bpy.types.Panel):
    bl_label = "Literal panel"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'

    def draw(self, context):
        self.layout.operator("wm.cgb_literal")
        bpy.ops.wm.cgb_literal()


classes = [CGB_OT_literal, CGB_PT_literal_panel]


def register():
    for cls in classes:
        bpy.utils.register_class(cls)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER register Operator CGB_OT_literal',
          'BLENDER Operator.execute CGB_OT_literal.execute',
          'BLENDER register Panel CGB_PT_literal_panel',
          'BLENDER Panel.draw CGB_PT_literal_panel.draw',
          'BLENDER ui-operator wm.cgb_literal',
          'BLENDER bpy-ops wm.cgb_literal',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'references:CGB_OT_literal', // register site
          'references:CGB_OT_literal', // layout.operator("wm.cgb_literal")
          'references:CGB_OT_literal', // bpy.ops.wm.cgb_literal()
          'references:CGB_PT_literal_panel',
          'references:blender:host:CGB_OT_literal.execute',
          'references:blender:host:CGB_PT_literal_panel.draw',
        ].sort()
      );
    });

    it('operator idname charset validation: invalid idnames emit nothing', () => {
      const result = extract(`
import bpy


def draw_buttons(layout):
    layout.operator("WM.bad_case")
    layout.operator("wm.too.many.dots")
    layout.operator("wm.good_name")
    bpy.ops.WM.Bad()
`);
      expect(nodeNames(result)).toEqual(['BLENDER ui-operator wm.good_name']);
      expect(refPairs(result)).toEqual(['references:blender:idname:wm.good_name']);
    });

    it('unknown idnames become blender:idname: refs; bl_parent_id and .menu() skip the operator charset rule', () => {
      const result = extract(`
import bpy


class VIEW3D_PT_cgb_child(bpy.types.Panel):
    bl_label = "Child"
    bl_parent_id = "VIEW3D_PT_other_file_parent"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'

    def draw(self, context):
        self.layout.menu("VIEW3D_MT_cgb_extras")


def register():
    bpy.utils.register_class(VIEW3D_PT_cgb_child)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER register Panel VIEW3D_PT_cgb_child',
          'BLENDER Panel.draw VIEW3D_PT_cgb_child.draw',
          'BLENDER panel-parent VIEW3D_PT_other_file_parent',
          'BLENDER ui-menu VIEW3D_MT_cgb_extras',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'references:VIEW3D_PT_cgb_child',
          'references:blender:host:VIEW3D_PT_cgb_child.draw',
          'references:blender:idname:VIEW3D_PT_other_file_parent',
          'references:blender:idname:VIEW3D_MT_cgb_extras',
        ].sort()
      );
      const parent = result.nodes.find((n) => n.name.startsWith('BLENDER panel-parent'));
      expect(parent?.startLine).toBe(7); // the bl_parent_id line itself, not the class header
    });

    it('fixture 09: computed (f-string) bl_idname is never guessed and emits no extra node', () => {
      const result = extract(`
import bpy

_PREFIX = "wm"


class CGB_OT_dynamic_id(bpy.types.Operator):
    bl_idname = f"{_PREFIX}.cgb_dynamic"
    bl_label = "Dynamic idname"

    def execute(self, context):
        return {'FINISHED'}


def register():
    bpy.utils.register_class(CGB_OT_dynamic_id)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER register Operator CGB_OT_dynamic_id',
          'BLENDER Operator.execute CGB_OT_dynamic_id.execute',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'references:CGB_OT_dynamic_id',
          'references:blender:host:CGB_OT_dynamic_id.execute',
        ].sort()
      );
    });
  });

  describe('extract() — properties and callbacks', () => {
    it('fixture 04: RNA property injection with type/update refs, no double emission', () => {
      const result = extract(`
import bpy


def update_settings(self, context):
    return None


class CGB_PG_settings(bpy.types.PropertyGroup):
    title: bpy.props.StringProperty(name="Title")


classes = (CGB_PG_settings,)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)
    bpy.types.Scene.cgb_settings = bpy.props.PointerProperty(
        type=CGB_PG_settings,
        update=update_settings,
    )
    bpy.types.Scene.cgb_items = bpy.props.CollectionProperty(type=CGB_PG_settings)


def unregister():
    del bpy.types.Scene.cgb_items
    del bpy.types.Scene.cgb_settings
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER module unregister()',
          'BLENDER register PropertyGroup CGB_PG_settings',
          'BLENDER RNA Scene.cgb_settings',
          'BLENDER RNA Scene.cgb_items',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'function_ref:unregister',
          'function_ref:update_settings', // exactly once (injection path only)
          'references:CGB_PG_settings', // register site
          'references:CGB_PG_settings', // PointerProperty(type=...)
          'references:CGB_PG_settings', // CollectionProperty(type=...)
        ].sort()
      );
    });

    it('fixture 05: menu append + timer callbacks', () => {
      const result = extract(`
import bpy


def draw_cgb_menu(self, context):
    self.layout.label(text="CGB")


class CGB_OT_timer(bpy.types.Operator):
    bl_idname = "wm.cgb_timer"
    bl_label = "Timer"

    @classmethod
    def collect_materials(cls):
        return None

    def execute(self, context):
        return {'FINISHED'}


def register():
    bpy.utils.register_class(CGB_OT_timer)
    bpy.types.VIEW3D_MT_object.append(draw_cgb_menu)
    bpy.app.timers.register(CGB_OT_timer.collect_materials)


def unregister():
    bpy.types.VIEW3D_MT_object.remove(draw_cgb_menu)
    bpy.utils.unregister_class(CGB_OT_timer)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER module unregister()',
          'BLENDER register Operator CGB_OT_timer',
          'BLENDER Operator.execute CGB_OT_timer.execute',
          'BLENDER menu-append draw_cgb_menu',
          'BLENDER timer CGB_OT_timer.collect_materials',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'function_ref:unregister',
          'function_ref:draw_cgb_menu',
          'function_ref:collect_materials',
          'references:CGB_OT_timer',
          'references:blender:host:CGB_OT_timer.execute',
        ].sort()
      );
    });

    it('fixture 06: callable EnumProperty items becomes a function_ref', () => {
      const result = extract(`
import bpy


def get_choices(self, context):
    return [
        ('ONE', 'One', ''),
        ('TWO', 'Two', ''),
    ]


class CGB_OT_enum(bpy.types.Operator):
    bl_idname = "wm.cgb_enum"
    bl_label = "Enum"
    choice: bpy.props.EnumProperty(items=get_choices)

    def execute(self, context):
        return {'FINISHED'}


def register():
    bpy.utils.register_class(CGB_OT_enum)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER register Operator CGB_OT_enum',
          'BLENDER Operator.execute CGB_OT_enum.execute',
          'BLENDER property EnumProperty',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'function_ref:get_choices',
          'references:CGB_OT_enum',
          'references:blender:host:CGB_OT_enum.execute',
        ].sort()
      );
    });

    it('static EnumProperty items tuple is data, not a callback', () => {
      const result = extract(`
import bpy


class CGB_OT_static_enum(bpy.types.Operator):
    bl_idname = "wm.cgb_static_enum"
    bl_label = "Static enum"
    choice: bpy.props.EnumProperty(items=(('A', 'A', ''), ('B', 'B', '')))

    def execute(self, context):
        return {'FINISHED'}


def register():
    bpy.utils.register_class(CGB_OT_static_enum)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER register Operator CGB_OT_static_enum',
          'BLENDER Operator.execute CGB_OT_static_enum.execute',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'references:CGB_OT_static_enum',
          'references:blender:host:CGB_OT_static_enum.execute',
        ].sort()
      );
    });

    it('callback registration surfaces: handlers, draw handler, msgbus, manual map, cli, gizmo, macro', () => {
      const result = extract(`
import bpy

from .macros import CGB_OT_macro


def on_load(dummy):
    return None


def draw_px():
    return None


def on_rename():
    return None


def manual_map():
    return ("https://docs", ())


def cli_run(args):
    return 0


class CGB_GGT_widgets(bpy.types.GizmoGroup):
    bl_idname = "CGB_GGT_widgets"
    bl_label = "Widgets"

    def setup(self, context):
        gz = self.gizmos.new("GIZMO_GT_arrow_3d")
        gz.target_set_operator("wm.cgb_fire")


def register():
    bpy.utils.register_class(CGB_GGT_widgets)
    bpy.app.handlers.load_post.append(on_load)
    bpy.types.SpaceView3D.draw_handler_add(draw_px, (), 'WINDOW', 'POST_PIXEL')
    bpy.msgbus.subscribe_rna(
        key=(bpy.types.Object, "name"),
        owner=object(),
        args=(),
        notify=on_rename,
    )
    bpy.utils.register_manual_map(manual_map)
    bpy.utils.register_cli_command("cgb", cli_run)
    CGB_OT_macro.define("wm.cgb_fire")
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER register GizmoGroup CGB_GGT_widgets',
          'BLENDER GizmoGroup.setup CGB_GGT_widgets.setup',
          'BLENDER gizmo-target wm.cgb_fire',
          'BLENDER handler-load_post on_load',
          'BLENDER draw-handler draw_px',
          'BLENDER msgbus-notify on_rename',
          'BLENDER manual-map manual_map',
          'BLENDER cli-command cli_run',
          'BLENDER macro-define wm.cgb_fire',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'function_ref:on_load',
          'function_ref:draw_px',
          'function_ref:on_rename',
          'function_ref:manual_map',
          'function_ref:cli_run',
          'references:CGB_GGT_widgets',
          'references:blender:host:CGB_GGT_widgets.setup',
          'references:blender:idname:wm.cgb_fire', // gizmo target_set_operator
          'references:blender:idname:wm.cgb_fire', // macro define
        ].sort()
      );
    });
  });

  describe('extract() — false-positive guards', () => {
    it('fixture 07: isinstance/subscript bpy.types mentions emit nothing', () => {
      const result = extract(`
from typing import Generic, TypeVar
import bpy

T = TypeVar("T")


class SpecificExporter(Generic[T]):
    pass


class NodeTreeExporter(SpecificExporter[bpy.types.NodeTree]):
    def accepts(self, value):
        return isinstance(value, bpy.types.NodeTree)


def accepts_node(value):
    return isinstance(value, bpy.types.Node)
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('fixture 08: dynamic __annotations__ property injection emits nothing', () => {
      const result = extract(`
import bpy

KNOWN_TYPES = (bpy.types.Object, bpy.types.Material)


class CGB_PG_dynamic(bpy.types.PropertyGroup):
    pass


def add_dynamic_props(prefix, group_type):
    for ty in KNOWN_TYPES:
        group_type.__annotations__[f"{prefix}{ty.__name__}"] = bpy.props.PointerProperty(type=ty)
        group_type.__annotations__[f"{prefix}{ty.__name__}_name"] = bpy.props.StringProperty()
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('non-Blender Python emits nothing', () => {
      const result = extract(`
def helper():
    return 1
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('bpy mentioned only in comments/docstrings emits nothing', () => {
      const result = extract(`
"""Utility helpers.

Example (do not run): bpy.ops.wm.save_mainfile()
"""


# import bpy would go here in the real add-on
def helper():
    return 1
`);
      expect(result).toEqual({ nodes: [], references: [] });
    });

    it('non-Python files emit nothing', () => {
      expect(blenderResolver.extract!('notes.txt', 'import bpy')).toEqual({
        nodes: [],
        references: [],
      });
    });
  });

  describe('extract() — legacy and smoke', () => {
    it('fixture 10: bl_info gates detection but emits no node', () => {
      const result = extract(`
import bpy

bl_info = {
    "name": "Legacy CGB",
    "blender": (4, 2, 0),
    "category": "Development",
}


class CGB_OT_legacy(bpy.types.Operator):
    bl_idname = "wm.cgb_legacy"
    bl_label = "Legacy"

    def execute(self, context):
        return {'FINISHED'}


def register():
    bpy.utils.register_class(CGB_OT_legacy)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER register Operator CGB_OT_legacy',
          'BLENDER Operator.execute CGB_OT_legacy.execute',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'references:CGB_OT_legacy',
          'references:blender:host:CGB_OT_legacy.execute',
        ].sort()
      );
    });

    it('realistic add-on smoke: full surface in one file', () => {
      const result = extract(`
import bpy
from bpy.types import (
    Operator,
    Panel,
)

addon_keymaps = []


def menu_draw(self, context):
    self.layout.operator(SCENE_OT_cgb_export.bl_idname)


class SCENE_OT_cgb_export(Operator):
    bl_idname = "scene.cgb_export"
    bl_label = "CGB Export"

    @classmethod
    def poll(cls, context):
        return context.scene is not None

    def execute(self, context):
        return {'FINISHED'}


class VIEW3D_PT_cgb_main(Panel):
    bl_label = "CGB"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'

    def draw(self, context):
        self.layout.operator("scene.cgb_export")


class VIEW3D_PT_cgb_child(Panel):
    bl_label = "CGB Child"
    bl_parent_id = "VIEW3D_PT_cgb_main"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'

    def draw(self, context):
        self.layout.menu("VIEW3D_MT_cgb_extras")


classes = (
    SCENE_OT_cgb_export,
    VIEW3D_PT_cgb_main,
    VIEW3D_PT_cgb_child,
)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)
    bpy.types.VIEW3D_MT_object.append(menu_draw)
    wm = bpy.context.window_manager
    km = wm.keyconfigs.addon.keymaps.new(name='3D View', space_type='VIEW_3D')
    kmi = km.keymap_items.new("scene.cgb_export", 'E', 'PRESS', ctrl=True)
    addon_keymaps.append((km, kmi))


def unregister():
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER module unregister()',
          'BLENDER register Operator SCENE_OT_cgb_export',
          'BLENDER Operator.poll SCENE_OT_cgb_export.poll',
          'BLENDER Operator.execute SCENE_OT_cgb_export.execute',
          'BLENDER register Panel VIEW3D_PT_cgb_main',
          'BLENDER Panel.draw VIEW3D_PT_cgb_main.draw',
          'BLENDER register Panel VIEW3D_PT_cgb_child',
          'BLENDER Panel.draw VIEW3D_PT_cgb_child.draw',
          'BLENDER panel-parent VIEW3D_PT_cgb_main',
          'BLENDER ui-menu VIEW3D_MT_cgb_extras',
          'BLENDER ui-operator-class-attr SCENE_OT_cgb_export',
          'BLENDER ui-operator scene.cgb_export',
          'BLENDER menu-append menu_draw',
          'BLENDER keymap scene.cgb_export',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'function_ref:unregister',
          'function_ref:menu_draw',
          'references:SCENE_OT_cgb_export', // register site
          'references:SCENE_OT_cgb_export', // menu_draw class-attr
          'references:SCENE_OT_cgb_export', // panel draw literal
          'references:SCENE_OT_cgb_export', // keymap literal
          'references:VIEW3D_PT_cgb_main', // register site
          'references:VIEW3D_PT_cgb_main', // bl_parent_id
          'references:VIEW3D_PT_cgb_child',
          'references:blender:host:SCENE_OT_cgb_export.poll',
          'references:blender:host:SCENE_OT_cgb_export.execute',
          'references:blender:host:VIEW3D_PT_cgb_main.draw',
          'references:blender:host:VIEW3D_PT_cgb_child.draw',
          'references:blender:idname:VIEW3D_MT_cgb_extras',
        ].sort()
      );
    });
  });

  describe('detect()', () => {
    it('detects an extension by manifest and skips theme extensions', () => {
      const addonCtx = makeContext({
        fileExists: (p) => p === 'blender_manifest.toml',
        readFile: (p) =>
          p === 'blender_manifest.toml' ? 'schema_version = "1.0.0"\nid = "my_tool"\ntype = "add-on"\n' : null,
        getAllFiles: () => ['blender_manifest.toml', '__init__.py'],
      });
      expect(blenderResolver.detect(addonCtx)).toBe(true);

      const themeCtx = makeContext({
        fileExists: (p) => p === 'blender_manifest.toml',
        readFile: (p) =>
          p === 'blender_manifest.toml' ? 'schema_version = "1.0.0"\nid = "my_theme"\ntype = "theme"\n' : null,
        getAllFiles: () => ['blender_manifest.toml'],
      });
      expect(blenderResolver.detect(themeCtx)).toBe(false);
    });

    it('detects a legacy add-on by bpy import in a package entry file', () => {
      const ctx = makeContext({
        readFile: (p) => (p === 'my_addon/__init__.py' ? 'import bpy\n\nbl_info = {}\n' : null),
        getAllFiles: () => ['my_addon/__init__.py', 'my_addon/ops.py'],
      });
      expect(blenderResolver.detect(ctx)).toBe(true);
    });

    it('does not detect non-Blender Python projects', () => {
      const ctx = makeContext({
        readFile: () => 'import os\n',
        getAllFiles: () => ['pkg/__init__.py', 'pkg/main.py'],
      });
      expect(blenderResolver.detect(ctx)).toBe(false);
    });
  });

  describe('claimsReference()', () => {
    it('claims synthetic blender refs and bl_ext module names only', () => {
      expect(blenderResolver.claimsReference!('blender:host:CGB_OT_x.execute')).toBe(true);
      expect(blenderResolver.claimsReference!('blender:idname:wm.cgb_x')).toBe(true);
      expect(blenderResolver.claimsReference!('bl_ext.user_default.my_tool.utils')).toBe(true);
      expect(blenderResolver.claimsReference!('wm.cgb_x')).toBe(false);
      expect(blenderResolver.claimsReference!('register')).toBe(false);
    });
  });

  describe('resolve()', () => {
    it('resolves bl_ext.{repo}.{id} virtual-package-root module imports', () => {
      const utilsFile = makeSymbol({
        id: 'file:my_ext/utils.py',
        kind: 'file',
        name: 'utils.py',
        filePath: 'my_ext/utils.py',
        startLine: 1,
        endLine: 1,
      });
      const ctx = makeContext({
        readFile: (p) =>
          p === 'my_ext/blender_manifest.toml'
            ? 'schema_version = "1.0.0"\nid = "my_tool"\ntype = "add-on"\n'
            : null,
        getAllFiles: () => ['my_ext/blender_manifest.toml', 'my_ext/__init__.py', 'my_ext/utils.py'],
        getNodesByName: (n) => (n === 'utils.py' ? [utilsFile] : []),
      });

      const resolved = blenderResolver.resolve(
        makeRef({
          referenceName: 'bl_ext.user_default.my_tool.utils',
          referenceKind: 'imports',
          filePath: 'my_ext/__init__.py',
        }),
        ctx
      );
      expect(resolved?.targetNodeId).toBe('file:my_ext/utils.py');
      expect(resolved?.confidence).toBe(0.9);
      expect(resolved?.resolvedBy).toBe('framework');

      // A different extension id never resolves against this manifest.
      const foreign = blenderResolver.resolve(
        makeRef({
          referenceName: 'bl_ext.user_default.other_tool.utils',
          referenceKind: 'imports',
          filePath: 'my_ext/__init__.py',
        }),
        ctx
      );
      expect(foreign).toBeNull();
    });

    it('resolves from-imports whose source is a bl_ext module', () => {
      const utilsFile = makeSymbol({
        id: 'file:my_ext/utils.py',
        kind: 'file',
        name: 'utils.py',
        filePath: 'my_ext/utils.py',
        startLine: 1,
        endLine: 1,
      });
      const helperFn = makeSymbol({
        id: 'function:my_ext/utils.py:helper:3',
        kind: 'function',
        name: 'helper',
        filePath: 'my_ext/utils.py',
        startLine: 3,
        endLine: 5,
      });
      const ctx = makeContext({
        readFile: (p) =>
          p === 'my_ext/blender_manifest.toml'
            ? 'schema_version = "1.0.0"\nid = "my_tool"\ntype = "add-on"\n'
            : null,
        getAllFiles: () => ['my_ext/blender_manifest.toml', 'my_ext/utils.py', 'my_ext/tools.py'],
        getNodesByName: (n) => (n === 'utils.py' ? [utilsFile] : []),
        getNodesInFile: (fp) => (fp === 'my_ext/utils.py' ? [helperFn] : []),
        getImportMappings: (fp) =>
          fp === 'my_ext/tools.py'
            ? [
                {
                  localName: 'helper',
                  exportedName: 'helper',
                  source: 'bl_ext.user_default.my_tool.utils',
                  isDefault: false,
                  isNamespace: false,
                },
              ]
            : [],
      });

      const resolved = blenderResolver.resolve(
        makeRef({ referenceName: 'helper', filePath: 'my_ext/tools.py' }),
        ctx
      );
      expect(resolved?.targetNodeId).toBe('function:my_ext/utils.py:helper:3');
      expect(resolved?.confidence).toBe(0.9);
    });

    it('resolves blender:host: refs by exact class containment only', () => {
      const cls = makeSymbol({
        id: 'class:addon/__init__.py:CGB_OT_x:5',
        kind: 'class',
        name: 'CGB_OT_x',
        filePath: 'addon/__init__.py',
        startLine: 5,
        endLine: 12,
      });
      const method = makeSymbol({
        id: 'method:addon/__init__.py:execute:8',
        kind: 'method',
        name: 'execute',
        filePath: 'addon/__init__.py',
        startLine: 8,
        endLine: 10,
      });
      const outsideMethod = makeSymbol({
        id: 'function:addon/__init__.py:draw:20',
        kind: 'function',
        name: 'draw',
        filePath: 'addon/__init__.py',
        startLine: 20,
        endLine: 22,
      });
      const ctx = makeContext({
        getNodesByName: (n) => {
          if (n === 'CGB_OT_x') return [cls];
          if (n === 'execute') return [method];
          if (n === 'draw') return [outsideMethod];
          return [];
        },
      });

      const resolved = blenderResolver.resolve(
        makeRef({ referenceName: 'blender:host:CGB_OT_x.execute' }),
        ctx
      );
      expect(resolved?.targetNodeId).toBe('method:addon/__init__.py:execute:8');
      expect(resolved?.confidence).toBe(0.85);

      // A same-file def OUTSIDE the class span is NOT the host callback.
      const notContained = blenderResolver.resolve(
        makeRef({ referenceName: 'blender:host:CGB_OT_x.draw' }),
        ctx
      );
      expect(notContained).toBeNull();
    });

    it('resolves blender:idname: refs through the lazy project idname index', () => {
      const opsSource = `
import bpy


class CGB_OT_remote(bpy.types.Operator):
    bl_idname = "wm.remote_op"
    bl_label = "Remote"

    def execute(self, context):
        return {'FINISHED'}


class VIEW3D_PT_remote_panel(bpy.types.Panel):
    bl_label = "Remote panel"

    def draw(self, context):
        pass
`;
      const remoteCls = makeSymbol({
        id: 'class:addon/ops.py:CGB_OT_remote:4',
        kind: 'class',
        name: 'CGB_OT_remote',
        filePath: 'addon/ops.py',
        startLine: 4,
        endLine: 10,
      });
      const panelCls = makeSymbol({
        id: 'class:addon/ops.py:VIEW3D_PT_remote_panel:13',
        kind: 'class',
        name: 'VIEW3D_PT_remote_panel',
        filePath: 'addon/ops.py',
        startLine: 13,
        endLine: 17,
      });
      const ctx = makeContext({
        readFile: (p) => (p === 'addon/ops.py' ? opsSource : null),
        getAllFiles: () => ['addon/__init__.py', 'addon/ops.py'],
        getNodesByName: (n) => {
          if (n === 'CGB_OT_remote') return [remoteCls];
          if (n === 'VIEW3D_PT_remote_panel') return [panelCls];
          return [];
        },
      });

      // Literal bl_idname from another file.
      const op = blenderResolver.resolve(makeRef({ referenceName: 'blender:idname:wm.remote_op' }), ctx);
      expect(op?.targetNodeId).toBe('class:addon/ops.py:CGB_OT_remote:4');
      expect(op?.confidence).toBe(0.8);

      // Panel default idname (= class name) from another file.
      const panel = blenderResolver.resolve(
        makeRef({ referenceName: 'blender:idname:VIEW3D_PT_remote_panel' }),
        ctx
      );
      expect(panel?.targetNodeId).toBe('class:addon/ops.py:VIEW3D_PT_remote_panel:13');

      // Unknown idname stays unresolved.
      expect(blenderResolver.resolve(makeRef({ referenceName: 'blender:idname:wm.nope' }), ctx)).toBeNull();
    });
  });

  describe('extract() — review follow-ups (I-1 dotted class-attr, I-2 annotated register, M-7 keymap)', () => {
    it('I-1: dotted module.Class.bl_idname operator arg links to the tail class', () => {
      const result = extract(`
import bpy

from . import ops


class CGB_PT_dotted(bpy.types.Panel):
    bl_label = "Dotted"

    def draw(self, context):
        self.layout.operator(ops.CGB_OT_target.bl_idname)


def register():
    bpy.utils.register_class(CGB_PT_dotted)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER register Panel CGB_PT_dotted',
          'BLENDER Panel.draw CGB_PT_dotted.draw',
          'BLENDER ui-operator-class-attr CGB_OT_target', // dotted path, tail class bound
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'references:CGB_PT_dotted', // register site
          'references:CGB_OT_target', // ops.CGB_OT_target.bl_idname -> tail class
          'references:blender:host:CGB_PT_dotted.draw',
        ].sort()
      );
    });

    it('I-2: annotated def register() -> None: still emits the module entry-point node', () => {
      const result = extract(`
import bpy


class CGB_OT_annot(bpy.types.Operator):
    bl_idname = "wm.cgb_annot"
    bl_label = "Annotated"

    def execute(self, context):
        bpy.ops.wm.cgb_annot()
        return {'FINISHED'}


classes = (
    CGB_OT_annot,
)


def register() -> None:
    for cls in classes:
        bpy.utils.register_class(cls)


def unregister() -> None:
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER module unregister()',
          'BLENDER register Operator CGB_OT_annot',
          'BLENDER Operator.execute CGB_OT_annot.execute',
          'BLENDER bpy-ops wm.cgb_annot',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'function_ref:unregister',
          'references:CGB_OT_annot', // register site
          'references:CGB_OT_annot', // bpy.ops call resolved to the in-file class
          'references:blender:host:CGB_OT_annot.execute',
        ].sort()
      );
    });

    it('M-7: keymap_items.new(Class.bl_idname, ...) links to the class (regression guard)', () => {
      const result = extract(`
import bpy


class CGB_OT_key(bpy.types.Operator):
    bl_idname = "wm.cgb_key"
    bl_label = "Keymap target"

    def execute(self, context):
        return {'FINISHED'}


addon_keymaps = []


def register():
    bpy.utils.register_class(CGB_OT_key)
    km = bpy.context.window_manager.keyconfigs.addon.keymaps.new(name="Object Mode")
    km.keymap_items.new(CGB_OT_key.bl_idname, 'A', 'PRESS')
`);
      expect(nodeNames(result)).toEqual(
        [
          'BLENDER module register()',
          'BLENDER register Operator CGB_OT_key',
          'BLENDER Operator.execute CGB_OT_key.execute',
          'BLENDER keymap-class-attr CGB_OT_key',
        ].sort()
      );
      expect(refPairs(result)).toEqual(
        [
          'function_ref:register',
          'references:CGB_OT_key', // register site
          'references:CGB_OT_key', // keymap_items.new(CGB_OT_key.bl_idname, ...)
          'references:blender:host:CGB_OT_key.execute',
        ].sort()
      );
    });
  });
});
