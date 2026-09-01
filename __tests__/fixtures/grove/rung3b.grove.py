"""GN straight-skeleton vertical slice (convex outline) - Opus 5 lane.

One convex, planar, CCW outline face at z=0 in; one straight-skeleton roof
mesh out (one n-gon per eave, vertex z = event time, unit speed), joined with
the skeleton arcs as loose-edge evidence geometry.

Trees:
  opus.gnslice.vel.v1     - 2x2 solve for a bisector velocity from two normals
  opus.gnslice.rebuild.v1 - A5 store-chain rebase carrier (fixed store order)
  opus.gnslice.roof.v1    - the root tree: S1..S8 + rung-2 S7a split stage
Structural revision (2026-08-26, WHOLE-GRAPH-REVISION-CONTRACT.md S6):
solve-zone stage bodies extract into sibling defs one at a time;
opus.gnslice.collapse.v1 (skel_collapse, S3 edge-event candidate field)
is first. chase/lavring/spscan predate the revision.

Rung-2 (2026-08-23): reflex split events per oracle _split_event/_do_split
(unit weights): pair scan -> per-reflex argmin -> site acceptance (tie band,
edge-batch supersession, cross-LAV latch, det guard, capacity latch) -> A/B
newborn columns + survivor pointer patches + hit-at-u/w death arcs, folded
into the A5 rebuild. See JOURNAL.md P11.

Design and decisions: see ARTIFACT.md sections 1 and 2.
"""

from src.grove import node_tree, repeat_zone
from src.grove.geo import (
    accumulate_field,
    attribute_domain_size,
    attribute_statistic,
    boolean_math,
    combine_xyz,
    compare,
    curve_of_point,
    curve_to_points,
    curve_to_mesh,
    delete_geometry,
    edges_to_face_groups,
    face_of_corner,
    fill_curve,
    filter_list,
    float_to_int,
    input_index,
    input_mesh_edge_neighbors,
    input_mesh_edge_vertices,
    input_mesh_island,
    input_mesh_vertex_neighbors,
    input_named_attribute,
    input_position,
    input_spline_cyclic,
    integer_math,
    instance_on_points,
    join_geometry,
    get_attribute_names,
    list_length,
    math,
    merge_by_distance,
    mesh_line,
    mesh_to_curve,
    mesh_to_points,
    offset_point_in_curve,
    points,
    points_of_curve,
    points_to_curves,
    remove_attribute,
    separate_geometry,
    realize_instances,
    sample_index,
    sample_nearest,
    separate_xyz,
    set_position,
    set_spline_cyclic,
    sort_elements,
    spline_parameter,
    store_named_attribute,
    switch,
    vector_math,
)
from src.grove.types import Boolean, Float, Geometry, Integer, Vector


@node_tree(id="opus.gnslice.vel.v1", target="geometry")
def vel2(na: Vector, nb: Vector, wp: Float = 1.0, wq: Float = 1.0) -> Vector:
    """Velocity v with <v, na> == wp and <v, nb> == wq (offset bisector).

    Weighted form (oracle _refresh_vertex): at wp = wq = 1 the multiplies
    are 1.0 * x, bit-identical to the rung-2 unit form.
    """
    sa = separate_xyz(vector=na)
    sb = separate_xyz(vector=nb)
    det = sa.x * sb.y - sa.y * sb.x
    # P0-R2b plus annulus determinant-envelope candidate: condition the
    # singular denominator at the measured binary32 boundary and preserve the
    # equal-weight same-direction rider limit (v = wp * na). Antiparallel
    # singular pairs remain stationary; nonparallel pairs retain Cramer.
    det_ok = compare(
        a=math(value=det, operation="ABSOLUTE"), b=5e-6, operation="GREATER_EQUAL"
    )
    det_s = switch(switch=det_ok, false=1.0, true=det, input_type="FLOAT")
    vx = (wp * sb.y - wq * sa.y) / det_s
    vy = (sa.x * wq - sb.x * wp) / det_s
    v_cr = combine_xyz(x=vx, y=vy, z=0.0)
    dot_ab = sa.x * sb.x + sa.y * sb.y
    same_dir = compare(a=dot_ab, b=0.0, operation="GREATER_THAN")
    w_eq = compare(
        a=math(value=wp - wq, operation="ABSOLUTE"), b=0.0, operation="LESS_EQUAL"
    )
    rider = boolean_math(boolean=same_dir, boolean_001=w_eq, operation="AND")
    v_rd = vector_math(vector=na, scale=wp, operation="SCALE")
    v_sing = switch(switch=rider, false=(0.0, 0.0, 0.0), true=v_rd, input_type="VECTOR")
    return switch(switch=det_ok, false=v_sing, true=v_cr, input_type="VECTOR")


@node_tree(id="opus.gnslice.chase.v1", target="geometry")
def chase(front: Geometry, steps: Integer = 16) -> Geometry:
    """Store `sm` (collapse-chain tail) and `hd` (collapse-chain head).

    Reads `ce` (collapse mask, 1/0), `nx`, `pv` from the incoming point cloud.
    """
    seed_sm = store_named_attribute(
        geometry=front,
        name="sm",
        value=input_index() * 1.0,
        data_type="FLOAT",
        domain="POINT",
    )
    seed_hd = store_named_attribute(
        geometry=seed_sm,
        name="hd",
        value=input_index() * 1.0,
        data_type="FLOAT",
        domain="POINT",
    )

    @repeat_zone(iterations=steps)
    def walk(g: Geometry) -> Geometry:
        ce_fld = input_named_attribute(name="ce", data_type="FLOAT")
        nx_fld = input_named_attribute(name="nx", data_type="FLOAT")
        pv_fld = input_named_attribute(name="pv", data_type="FLOAT")

        cur_f = input_named_attribute(name="sm", data_type="FLOAT")
        cur_fi = float_to_int(float=cur_f, rounding_mode="ROUND")
        ce_here = sample_index(
            geometry=g, value=ce_fld, index=cur_fi, data_type="FLOAT", domain="POINT"
        )
        nx_here = sample_index(
            geometry=g, value=nx_fld, index=cur_fi, data_type="FLOAT", domain="POINT"
        )
        go_fwd = compare(a=ce_here, b=0.5, operation="GREATER_THAN")
        sm_next = switch(switch=go_fwd, false=cur_f, true=nx_here, input_type="FLOAT")

        cur_b = input_named_attribute(name="hd", data_type="FLOAT")
        cur_bi = float_to_int(float=cur_b, rounding_mode="ROUND")
        pv_here = sample_index(
            geometry=g, value=pv_fld, index=cur_bi, data_type="FLOAT", domain="POINT"
        )
        pv_here_i = float_to_int(float=pv_here, rounding_mode="ROUND")
        ce_at_pv = sample_index(
            geometry=g, value=ce_fld, index=pv_here_i, data_type="FLOAT", domain="POINT"
        )
        go_back = compare(a=ce_at_pv, b=0.5, operation="GREATER_THAN")
        hd_next = switch(switch=go_back, false=cur_b, true=pv_here, input_type="FLOAT")

        w_sm = store_named_attribute(
            geometry=g, name="sm", value=sm_next, data_type="FLOAT", domain="POINT"
        )
        return store_named_attribute(
            geometry=w_sm, name="hd", value=hd_next, data_type="FLOAT", domain="POINT"
        )

    return walk(seed_hd)


@node_tree(id="opus.gnslice.lavring.v1", target="geometry")
def lavring(front: Geometry, steps: Integer = 64) -> Geometry:
    """Stamp fresh `lav` circle ids onto a split body's child circles.

    Seeds on the incoming cloud: `anc` (1 on this body's newborn anchors,
    A and B alike) and `lvn` (the fresh circle-id candidate carried by that
    anchor). Every slot walks one full `pv` lap and adopts the minimum anchor
    id on its resulting circle. A circle with no anchor keeps its old id.
    The full-lap minimum is load-bearing for simultaneous cross-LAV merges:
    several event anchors may land on one rebuilt circle, and stopping at the
    first one would stamp different LAV ids onto adjacent slots.
    Chase-pattern walk with ONE vector state per point — lws = (cur slot,
    found flag, adopted id) — because per-iteration state split across
    several stores re-reads overwritten fields (store-order law; the bridge
    warns store-chain-overwrite on exactly that shape). Rewrites `lav`;
    reads `anc`, `lvn`, `nx`, `pv`.
    """
    seed_lws = store_named_attribute(
        geometry=front,
        name="lws",
        value=combine_xyz(x=input_index() * 1.0, y=0.0, z=-1.0),
        data_type="FLOAT_VECTOR",
        domain="POINT",
    )

    @repeat_zone(iterations=steps)
    def walk(g: Geometry) -> Geometry:
        anc_fld = input_named_attribute(name="anc", data_type="FLOAT")
        lvn_fld = input_named_attribute(name="lvn", data_type="FLOAT")
        pv_fld = input_named_attribute(name="pv", data_type="FLOAT")

        lws_f = input_named_attribute(name="lws", data_type="FLOAT_VECTOR")
        sep = separate_xyz(vector=lws_f)
        cur_i = float_to_int(float=sep.x, rounding_mode="ROUND")
        anc_here = sample_index(
            geometry=g, value=anc_fld, index=cur_i, data_type="FLOAT", domain="POINT"
        )
        lvn_here = sample_index(
            geometry=g, value=lvn_fld, index=cur_i, data_type="FLOAT", domain="POINT"
        )
        pv_here = sample_index(
            geometry=g, value=pv_fld, index=cur_i, data_type="FLOAT", domain="POINT"
        )
        walking = compare(a=sep.y, b=0.5, operation="LESS_THAN")
        hit = compare(a=anc_here, b=0.5, operation="GREATER_THAN")
        adopt = boolean_math(boolean=walking, boolean_001=hit, operation="AND")
        had_anchor = compare(a=sep.z, b=-0.5, operation="GREATER_THAN")
        anchor_min = switch(
            switch=had_anchor,
            false=lvn_here,
            true=math(value=sep.z, value_001=lvn_here, operation="MINIMUM"),
            input_type="FLOAT",
        )
        # Read the current row before closing the lap; then freeze.  This
        # keeps an anchor on the final row in the minimum and leaves an
        # untouched circle's sentinel at -1.
        lap = compare(a=pv_here, b=input_index() * 1.0, operation="EQUAL")
        stop_lap = boolean_math(boolean=walking, boolean_001=lap, operation="AND")
        cur_next = switch(switch=stop_lap, false=pv_here, true=sep.x, input_type="FLOAT")
        fnd_next = switch(switch=stop_lap, false=sep.y, true=1.0, input_type="FLOAT")
        lwl_next = switch(switch=adopt, false=sep.z, true=anchor_min, input_type="FLOAT")
        return store_named_attribute(
            geometry=g,
            name="lws",
            value=combine_xyz(x=cur_next, y=fnd_next, z=lwl_next),
            data_type="FLOAT_VECTOR",
            domain="POINT",
        )

    walked = walk(seed_lws)
    lav_old = input_named_attribute(name="lav", data_type="FLOAT")
    lwl_end = separate_xyz(
        vector=input_named_attribute(name="lws", data_type="FLOAT_VECTOR")
    ).z
    lav_new = switch(
        switch=compare(a=lwl_end, b=-0.5, operation="GREATER_THAN"),
        false=lav_old,
        true=lwl_end,
        input_type="FLOAT",
    )
    return store_named_attribute(
        geometry=walked, name="lav", value=lav_new, data_type="FLOAT", domain="POINT"
    )


@node_tree(id="opus.gnslice.spscan.v1", target="geometry")
def _sp_scan(
    geo: Geometry, tnow: Float, rsl: Float, asl: Float
) -> tuple[
    Float, Float, Float, Float, Vector,
    Float, Float, Float, Float, Vector,
    Float, Float, Float, Float, Float,
    Float, Vector, Vector,
    Vector, Float, Float, Float, Vector, Float,
    Vector, Float, Float, Float, Vector, Float,
    Float, Float,
]:
    """Field math for ONE split pair: reflex slot `rsl`, hit edge start `asl`.

    Mirrors skeleton_oracle._split_event (rung 3a: weighted, wk = w[a]):
        nk  = nr[a]                        hit-wall normal
        dv  = vl[r] . nk                   reflex closing speed on the wall
        den = dv - w[a]
        d0  = (ap[r] - ap[a]) . nk + at[a] r's anchor offset from wall base
        s   = (at[r]*dv - d0) / den        LINEAR in t (ray vs moving line)
        lam = ((pr(s)-pa(s)) . (pb(s)-pa(s))) / |pb(s)-pa(s)|^2
    Validity: |den| >= 1e-12, s > max(at_r, tnow) - 1e-6 (oracle-faithful
    freshness, see the comment at the gate), |edge| >= 1e-12 at s,
    -1e-7 <= lam <= 1 + 1e-7, non-adjacency (a != r, b != r), and
    same-circle membership lav_a == lav_r == lav_b — the oracle scans only
    r's LAV; without the gate a cross-circle pair can tie the true split at
    bit-equal s_c and win the a-credit tie-break (measured sw00, task #6).
    Invalid pairs score s_c = 1e9. Also derives the dispatch data per oracle _do_split's
    three lam bands: newborn A (born into r's slot) and B (spare slot)
    columns, hit-at-u / interior / hit-at-w classification, endpoint
    positions at s, and both bisector determinants (det guard, code 4).
    `rsl`/`asl` are FLOAT slot fields; samples read `geo` (the zone-input
    front -- old generation, chain-pinned).
    """
    f_ap = input_named_attribute(name="ap", data_type="FLOAT_VECTOR")
    f_at = input_named_attribute(name="at", data_type="FLOAT")
    f_vl = input_named_attribute(name="vl", data_type="FLOAT_VECTOR")
    f_nr = input_named_attribute(name="nr", data_type="FLOAT_VECTOR")
    f_ed = input_named_attribute(name="ed", data_type="FLOAT")
    f_nx = input_named_attribute(name="nx", data_type="FLOAT")
    f_pv = input_named_attribute(name="pv", data_type="FLOAT")
    f_lav = input_named_attribute(name="lav", data_type="FLOAT")
    f_w = input_named_attribute(name="w", data_type="FLOAT")

    r_i = float_to_int(float=rsl, rounding_mode="ROUND")
    a_i = float_to_int(float=asl, rounding_mode="ROUND")
    ap_r = sample_index(geometry=geo, value=f_ap, index=r_i, data_type="FLOAT_VECTOR", domain="POINT")
    at_r = sample_index(geometry=geo, value=f_at, index=r_i, data_type="FLOAT", domain="POINT")
    vl_r = sample_index(geometry=geo, value=f_vl, index=r_i, data_type="FLOAT_VECTOR", domain="POINT")
    ap_a = sample_index(geometry=geo, value=f_ap, index=a_i, data_type="FLOAT_VECTOR", domain="POINT")
    at_a = sample_index(geometry=geo, value=f_at, index=a_i, data_type="FLOAT", domain="POINT")
    vl_a = sample_index(geometry=geo, value=f_vl, index=a_i, data_type="FLOAT_VECTOR", domain="POINT")
    nr_a = sample_index(geometry=geo, value=f_nr, index=a_i, data_type="FLOAT_VECTOR", domain="POINT")
    ed_a = sample_index(geometry=geo, value=f_ed, index=a_i, data_type="FLOAT", domain="POINT")
    b_f = sample_index(geometry=geo, value=f_nx, index=a_i, data_type="FLOAT", domain="POINT")
    b_i = float_to_int(float=b_f, rounding_mode="ROUND")
    ap_b = sample_index(geometry=geo, value=f_ap, index=b_i, data_type="FLOAT_VECTOR", domain="POINT")
    at_b = sample_index(geometry=geo, value=f_at, index=b_i, data_type="FLOAT", domain="POINT")
    vl_b = sample_index(geometry=geo, value=f_vl, index=b_i, data_type="FLOAT_VECTOR", domain="POINT")
    nr_b = sample_index(geometry=geo, value=f_nr, index=b_i, data_type="FLOAT_VECTOR", domain="POINT")
    ed_b = sample_index(geometry=geo, value=f_ed, index=b_i, data_type="FLOAT", domain="POINT")
    pv_a_f = sample_index(geometry=geo, value=f_pv, index=a_i, data_type="FLOAT", domain="POINT")
    pv_a_i = float_to_int(float=pv_a_f, rounding_mode="ROUND")
    nr_pa = sample_index(geometry=geo, value=f_nr, index=pv_a_i, data_type="FLOAT_VECTOR", domain="POINT")
    ed_pa = sample_index(geometry=geo, value=f_ed, index=pv_a_i, data_type="FLOAT", domain="POINT")
    pv_r_f = sample_index(geometry=geo, value=f_pv, index=r_i, data_type="FLOAT", domain="POINT")
    pv_r_i = float_to_int(float=pv_r_f, rounding_mode="ROUND")
    nr_pr = sample_index(geometry=geo, value=f_nr, index=pv_r_i, data_type="FLOAT_VECTOR", domain="POINT")
    nr_r = sample_index(geometry=geo, value=f_nr, index=r_i, data_type="FLOAT_VECTOR", domain="POINT")
    ed_r = sample_index(geometry=geo, value=f_ed, index=r_i, data_type="FLOAT", domain="POINT")
    nx_r_f = sample_index(geometry=geo, value=f_nx, index=r_i, data_type="FLOAT", domain="POINT")
    lav_r = sample_index(geometry=geo, value=f_lav, index=r_i, data_type="FLOAT", domain="POINT")
    lav_a = sample_index(geometry=geo, value=f_lav, index=a_i, data_type="FLOAT", domain="POINT")
    # rung 3a: per-slot weight of the slot's OUT-edge (vertex i owns edge
    # i->i+1). w_a is the HIT edge's speed — the split timing denominator's
    # wk term (oracle _split_event: den = dv - wk).
    w_a = sample_index(geometry=geo, value=f_w, index=a_i, data_type="FLOAT", domain="POINT")
    w_b = sample_index(geometry=geo, value=f_w, index=b_i, data_type="FLOAT", domain="POINT")
    w_r = sample_index(geometry=geo, value=f_w, index=r_i, data_type="FLOAT", domain="POINT")
    w_pv_r = sample_index(geometry=geo, value=f_w, index=pv_r_i, data_type="FLOAT", domain="POINT")
    w_pv_a = sample_index(geometry=geo, value=f_w, index=pv_a_i, data_type="FLOAT", domain="POINT")

    dv = vector_math(vector=vl_r, vector_001=nr_a, operation="DOT_PRODUCT").value
    den = math(value=dv, value_001=w_a, operation="SUBTRACT")
    den_abs = math(value=den, operation="ABSOLUTE")
    den_ok = compare(a=den_abs, b=1e-12, operation="GREATER_EQUAL")
    den_s = switch(switch=den_ok, false=1.0, true=den, input_type="FLOAT")
    # d0 anchors the hit line at t=0: base = ap_a - nr_a*(w_a*at_a),
    # so d0 = (ap_r - ap_a).nr_a + w_a*at_a (oracle _split_event's
    # (r - base[k]).nk). The at_a term MUST carry w_a — unscaled it
    # shifts every candidate on a moved hit slot by
    # (w_a-1)*at_a/(dv-w_a), which is zero only when the slot never
    # moved or the weight is unit (why the corpus stayed green).
    # Measured fx11: hit slot born at the t=0.0754747 split with
    # w_a=15.8744 shifted s2 0.322298 -> 0.246868 — a phantom early
    # split the oracle never sees (KEY-INVERSION-SEARCH.txt stage6).
    d0 = math(
        value=vector_math(
            vector=vector_math(vector=ap_r, vector_001=ap_a, operation="SUBTRACT"),
            vector_001=nr_a,
            operation="DOT_PRODUCT",
        ).value,
        value_001=math(value=at_a, value_001=w_a, operation="MULTIPLY"),
        operation="ADD",
    )
    s_raw = math(
        value=math(
            value=math(value=at_r, value_001=dv, operation="MULTIPLY"),
            value_001=d0,
            operation="SUBTRACT",
        ),
        value_001=den_s,
        operation="DIVIDE",
    )
    # Freshness, split side (task #14 mechanism 2, AMENDED 2026-08-25):
    # relative band replaces the old absolute -1e-6 window. The oracle
    # admits s >= max(r.t, now) - 1e-9 (f64) so same-t events re-derive
    # and fire on the NEXT sequential scan (D1, fx8: a split losing
    # same-edge arbitration must re-derive at equal tnow). The absolute
    # 1e-6 absorbed the below-side ulps of that re-derivation, but f32
    # ulp crosses 1e-6 at t ~ 64, so at large event times (weight-scaled
    # inputs, times / c) the window collapsed to the strict form and
    # arcs were silently lost (measured fx8, weights x 1e-6: 9 arcs vs
    # 13, clean ec). The f32-honest reading of the oracle's window is a
    # RELATIVE below-side band: floor - floor*2^-21 (4-8 ulps by binade
    # position), scale-free on both metamorphic axes and ~21x tighter
    # than the tie batch window (tie_thr, 1e-5 relative), so it cannot
    # reorder genuinely distinct events. The contracted suppressed-site
    # STATE form was implemented and measured insufficient: it cannot
    # reach cross-type same-t pairs (fx7a regression, 6 vs 9 arcs) nor
    # the edge-side no-loser class -- DEAD-ENDS.md entries 1-5; Codex
    # consult 2026-08-25 adjudicated band-vs-state-hybrid as A (band
    # only, receipt .myriad/tasks/rung3a-mech2-consult/ARTIFACT.md).
    # Acceptance conditions carried with the amendment: per-iteration
    # clock monotonicity asserted in the test battery (tnow_out = t_min
    # must never regress) and admitted below-floor lateness recorded in
    # ulps; c < 1e-4 stays fail-closed pending mechanism 3's two-axis
    # window (uniform weight scale leaves w_hi/w_lo unchanged, so the
    # ratio-only code-8 gate cannot see it).
    t_floor = math(value=at_r, value_001=tnow, operation="MAXIMUM")
    fresh = compare(
        a=s_raw,
        b=math(
            value=t_floor,
            value_001=math(value=t_floor, value_001=4.76837158e-07, operation="MULTIPLY"),
            operation="SUBTRACT",
        ),
        operation="GREATER_THAN",
    )

    pos_r_s = vector_math(
        vector=ap_r,
        vector_001=vector_math(vector=vl_r, scale=s_raw - at_r, operation="SCALE"),
        operation="ADD",
    )
    pos_a_s = vector_math(
        vector=ap_a,
        vector_001=vector_math(vector=vl_a, scale=s_raw - at_a, operation="SCALE"),
        operation="ADD",
    )
    pos_b_s = vector_math(
        vector=ap_b,
        vector_001=vector_math(vector=vl_b, scale=s_raw - at_b, operation="SCALE"),
        operation="ADD",
    )
    # DEFECT B FIX (2026-08-25): the front packs ap as (x, y, at) -- initial
    # slots z=0=at, split newborns ap=nd_pick carry z=s_raw=at -- and vl.z=0,
    # so pos_*_s all carry z=at. The previous 3-D lam mixed anchor times into
    # the projection (fx11 it=3 r=7 a=10: 1.0005594 vs true 0.9999885 ->
    # hi-gate reject -> parity break; sliver pairs collapsed to lam=1
    # exactly). Project in 2D only, as the oracle does. nd's z stays s_raw.
    sep_r = separate_xyz(vector=pos_r_s)
    sep_a2 = separate_xyz(vector=pos_a_s)
    sep_b2 = separate_xyz(vector=pos_b_s)
    pr_xy = combine_xyz(x=sep_r.x, y=sep_r.y, z=0.0)
    pa_xy = combine_xyz(x=sep_a2.x, y=sep_a2.y, z=0.0)
    pb_xy = combine_xyz(x=sep_b2.x, y=sep_b2.y, z=0.0)
    evec = vector_math(vector=pb_xy, vector_001=pa_xy, operation="SUBTRACT")
    elen2 = vector_math(vector=evec, vector_001=evec, operation="DOT_PRODUCT").value
    elen_ok = compare(a=elen2, b=1e-24, operation="GREATER_EQUAL")
    elen2_s = math(value=elen2, value_001=1e-24, operation="MAXIMUM")
    lam = math(
        value=vector_math(
            vector=vector_math(vector=pr_xy, vector_001=pa_xy, operation="SUBTRACT"),
            vector_001=evec,
            operation="DOT_PRODUCT",
        ).value,
        value_001=elen2_s,
        operation="DIVIDE",
    )
    lam_lo = compare(a=lam, b=-1e-7, operation="GREATER_EQUAL")
    lam_hi = compare(a=lam, b=1.0 + 1e-7, operation="LESS_EQUAL")
    adj_a = compare(a=rsl, b=asl, operation="NOT_EQUAL")
    adj_b = compare(a=rsl, b=b_f, operation="NOT_EQUAL")
    # Candidate geometry is valid both for an ordinary same-LAV split and
    # for a reflex front hitting an edge on another LAV.  Hit-edge topology
    # (a/b same LAV and reciprocal pointers) is checked after winner resolve
    # in skel_arbitrate; it must not suppress a genuine cross-LAV merge here.
    ok_base = boolean_math(
        boolean=boolean_math(
            boolean=boolean_math(boolean=den_ok, boolean_001=elen_ok, operation="AND"),
            boolean_001=boolean_math(boolean=lam_lo, boolean_001=lam_hi, operation="AND"),
            operation="AND",
        ),
        boolean_001=boolean_math(
            boolean=adj_a, boolean_001=adj_b, operation="AND"
        ),
        operation="AND",
    )
    ok_all = boolean_math(boolean=ok_base, boolean_001=fresh, operation="AND")
    s_c = switch(switch=ok_all, false=1000000000.0, true=s_raw, input_type="FLOAT")

    at_u = compare(a=lam, b=1e-7, operation="LESS_EQUAL")
    at_w = compare(a=lam, b=1.0 - 1e-7, operation="GREATER_EQUAL")
    cls = switch(
        switch=at_u, false=switch(switch=at_w, false=1.0, true=2.0, input_type="FLOAT"),
        true=0.0, input_type="FLOAT",
    )
    nd = combine_xyz(x=sep_r.x, y=sep_r.y, z=s_raw)

    cls_le1 = compare(a=cls, b=1.5, operation="LESS_EQUAL")
    A_nr = switch(switch=cls_le1, false=nr_b, true=nr_a, input_type="VECTOR")
    A_ed = switch(switch=cls_le1, false=ed_b, true=ed_a, input_type="FLOAT")
    # A's out-edge weight mirrors the A_nr switch (same cls_le1 side pick);
    # the slot stores the weight of its own out-edge (carrier convention).
    A_w = switch(switch=cls_le1, false=w_b, true=w_a, input_type="FLOAT")
    bnx_f = sample_index(geometry=geo, value=f_nx, index=b_i, data_type="FLOAT", domain="POINT")
    A_nx = switch(switch=at_w, false=b_f, true=bnx_f, input_type="FLOAT")
    na_B = switch(switch=at_u, false=nr_a, true=nr_pa, input_type="VECTOR")
    # B's in-edge weight mirrors the na_B switch; B's out-edge IS r's old
    # out-edge, so B's stored weight is w_r.
    B_wp = switch(switch=at_u, false=w_a, true=w_pv_a, input_type="FLOAT")
    B_w = w_r
    B_pv = switch(switch=at_u, false=asl, true=pv_a_f, input_type="FLOAT")
    detA = separate_xyz(
        vector=vector_math(vector=nr_pr, vector_001=A_nr, operation="CROSS_PRODUCT")
    ).z
    detB = separate_xyz(
        vector=vector_math(vector=na_B, vector_001=nr_r, operation="CROSS_PRODUCT")
    ).z
    # vel2 divides by the flanking-wall cross product: when the child's det
    # vanishes (degenerate 2-ring child, fx4/fx5) the raw velocity is
    # inf/NaN and poisons every later anchored-position read. The degenerate
    # child terminates at birth and never consumes its velocity, so clamp
    # it to zero there (healthy children keep the exact vel2 value).
    A_vl = switch(
        switch=compare(
            a=math(value=detA, operation="ABSOLUTE"), b=1e-12, operation="GREATER_EQUAL"
        ),
        false=(0.0, 0.0, 0.0), true=vel2(na=nr_pr, nb=A_nr, wp=w_pv_r, wq=A_w), input_type="VECTOR",
    )
    B_vl = switch(
        switch=compare(
            a=math(value=detB, operation="ABSOLUTE"), b=1e-12, operation="GREATER_EQUAL"
        ),
        false=(0.0, 0.0, 0.0), true=vel2(na=na_B, nb=nr_r, wp=B_wp, wq=w_r), input_type="VECTOR",
    )
    return (
        s_c, s_raw, lam, cls, nd,
        b_f, pv_a_f, pv_r_f, nx_r_f, nr_r,
        ed_r, ed_a, ed_b, ed_pa, lav_r,
        lav_a, pos_a_s, pos_b_s,
        A_nr, A_ed, pv_r_f, A_nx, A_vl, A_w,
        nr_r, ed_r, B_pv, nx_r_f, B_vl, B_w,
        detA, detB,
    )


@node_tree(id="opus.gnslice.spcore.v1", target="geometry")
def sp_core(
    geo: Geometry, tnow: Float, rsl: Float, asl: Float
) -> tuple[
    Float, Boolean,
    Float, Float, Float, Vector,
    Float, Float, Float, Float, Vector,
    Float, Float, Float, Float, Float,
    Float, Vector, Vector,
    Vector, Float, Float, Vector, Float,
    Float, Vector, Float, Float, Float,
]:
    """Shared split-pair math (re-cut contract S2/S4): ONE home for every
    expression the score and resolve wrappers need -- sp_score and
    sp_resolve contain zero math of their own, so the contract's "new
    duplication NONE" holds by construction. THE one home for the DEFECT-B
    2-D projection lives here (lam block below).

    Output order: (s_c, ok_all) then the 27 resolve values in canonical
    order -- s_raw, lam, cls, nd, b_f, pv_a_f, pv_r_f, nx_r_f, nr_r,
    ed_r, ed_a, ed_b, ed_pa, lav_r, lav_a, pos_a_s, pos_b_s, A_nr, A_ed,
    A_nx, A_vl, A_w, B_pv, B_vl, B_w, detA, detB. The old 32-tuple's four
    D3 duplicate sockets exist ONCE here (verified against the consumer
    census, SPSCAN-RECUT-HARNESS-PLAN.md): old pos8/21 are both pv_r_f,
    pos9/28 both nx_r_f, pos10/25 both nr_r, pos11/26 both ed_r. ok_all
    was implicit in the old s_c switch; exported explicitly for the
    phase-2 lazy-winner wiring.
    Body byte-verbatim from _sp_scan -- including every weight-column
    sample, each of which feeds live math: w_a (denominator/d0/B_wp
    false), w_b (A_w false side), w_r (B_w), w_pv_r (A_vl wp), w_pv_a
    (B_wp true side).
    """
    f_ap = input_named_attribute(name="ap", data_type="FLOAT_VECTOR")
    f_at = input_named_attribute(name="at", data_type="FLOAT")
    f_vl = input_named_attribute(name="vl", data_type="FLOAT_VECTOR")
    f_nr = input_named_attribute(name="nr", data_type="FLOAT_VECTOR")
    f_ed = input_named_attribute(name="ed", data_type="FLOAT")
    f_nx = input_named_attribute(name="nx", data_type="FLOAT")
    f_pv = input_named_attribute(name="pv", data_type="FLOAT")
    f_lav = input_named_attribute(name="lav", data_type="FLOAT")
    f_w = input_named_attribute(name="w", data_type="FLOAT")

    r_i = float_to_int(float=rsl, rounding_mode="ROUND")
    a_i = float_to_int(float=asl, rounding_mode="ROUND")
    ap_r = sample_index(geometry=geo, value=f_ap, index=r_i, data_type="FLOAT_VECTOR", domain="POINT")
    at_r = sample_index(geometry=geo, value=f_at, index=r_i, data_type="FLOAT", domain="POINT")
    vl_r = sample_index(geometry=geo, value=f_vl, index=r_i, data_type="FLOAT_VECTOR", domain="POINT")
    ap_a = sample_index(geometry=geo, value=f_ap, index=a_i, data_type="FLOAT_VECTOR", domain="POINT")
    at_a = sample_index(geometry=geo, value=f_at, index=a_i, data_type="FLOAT", domain="POINT")
    vl_a = sample_index(geometry=geo, value=f_vl, index=a_i, data_type="FLOAT_VECTOR", domain="POINT")
    nr_a = sample_index(geometry=geo, value=f_nr, index=a_i, data_type="FLOAT_VECTOR", domain="POINT")
    ed_a = sample_index(geometry=geo, value=f_ed, index=a_i, data_type="FLOAT", domain="POINT")
    b_f = sample_index(geometry=geo, value=f_nx, index=a_i, data_type="FLOAT", domain="POINT")
    b_i = float_to_int(float=b_f, rounding_mode="ROUND")
    ap_b = sample_index(geometry=geo, value=f_ap, index=b_i, data_type="FLOAT_VECTOR", domain="POINT")
    at_b = sample_index(geometry=geo, value=f_at, index=b_i, data_type="FLOAT", domain="POINT")
    vl_b = sample_index(geometry=geo, value=f_vl, index=b_i, data_type="FLOAT_VECTOR", domain="POINT")
    nr_b = sample_index(geometry=geo, value=f_nr, index=b_i, data_type="FLOAT_VECTOR", domain="POINT")
    ed_b = sample_index(geometry=geo, value=f_ed, index=b_i, data_type="FLOAT", domain="POINT")
    pv_a_f = sample_index(geometry=geo, value=f_pv, index=a_i, data_type="FLOAT", domain="POINT")
    pv_a_i = float_to_int(float=pv_a_f, rounding_mode="ROUND")
    nr_pa = sample_index(geometry=geo, value=f_nr, index=pv_a_i, data_type="FLOAT_VECTOR", domain="POINT")
    ed_pa = sample_index(geometry=geo, value=f_ed, index=pv_a_i, data_type="FLOAT", domain="POINT")
    pv_r_f = sample_index(geometry=geo, value=f_pv, index=r_i, data_type="FLOAT", domain="POINT")
    pv_r_i = float_to_int(float=pv_r_f, rounding_mode="ROUND")
    nr_pr = sample_index(geometry=geo, value=f_nr, index=pv_r_i, data_type="FLOAT_VECTOR", domain="POINT")
    nx_r_f = sample_index(geometry=geo, value=f_nx, index=r_i, data_type="FLOAT", domain="POINT")
    nr_r = sample_index(geometry=geo, value=f_nr, index=r_i, data_type="FLOAT_VECTOR", domain="POINT")
    ed_r = sample_index(geometry=geo, value=f_ed, index=r_i, data_type="FLOAT", domain="POINT")
    lav_r = sample_index(geometry=geo, value=f_lav, index=r_i, data_type="FLOAT", domain="POINT")
    lav_a = sample_index(geometry=geo, value=f_lav, index=a_i, data_type="FLOAT", domain="POINT")
    # rung 3a: per-slot weight of the slot's OUT-edge (vertex i owns edge
    # i->i+1). w_a is the HIT edge's speed -- the split timing denominator's
    # wk term (oracle _split_event: den = dv - wk).
    w_a = sample_index(geometry=geo, value=f_w, index=a_i, data_type="FLOAT", domain="POINT")
    w_b = sample_index(geometry=geo, value=f_w, index=b_i, data_type="FLOAT", domain="POINT")
    w_r = sample_index(geometry=geo, value=f_w, index=r_i, data_type="FLOAT", domain="POINT")
    w_pv_r = sample_index(geometry=geo, value=f_w, index=pv_r_i, data_type="FLOAT", domain="POINT")
    w_pv_a = sample_index(geometry=geo, value=f_w, index=pv_a_i, data_type="FLOAT", domain="POINT")

    dv = vector_math(vector=vl_r, vector_001=nr_a, operation="DOT_PRODUCT").value
    den = math(value=dv, value_001=w_a, operation="SUBTRACT")
    den_abs = math(value=den, operation="ABSOLUTE")
    den_ok = compare(a=den_abs, b=1e-12, operation="GREATER_EQUAL")
    den_s = switch(switch=den_ok, false=1.0, true=den, input_type="FLOAT")
    # d0 anchors the hit line at t=0: base = ap_a - nr_a*(w_a*at_a),
    # so d0 = (ap_r - ap_a).nr_a + w_a*at_a (oracle _split_event's
    # (r - base[k]).nk). The at_a term MUST carry w_a.
    d0 = math(
        value=vector_math(
            vector=vector_math(vector=ap_r, vector_001=ap_a, operation="SUBTRACT"),
            vector_001=nr_a,
            operation="DOT_PRODUCT",
        ).value,
        value_001=math(value=at_a, value_001=w_a, operation="MULTIPLY"),
        operation="ADD",
    )
    s_raw = math(
        value=math(
            value=math(value=at_r, value_001=dv, operation="MULTIPLY"),
            value_001=d0,
            operation="SUBTRACT",
        ),
        value_001=den_s,
        operation="DIVIDE",
    )
    # Freshness, split side (task #14 mechanism 2, AMENDED 2026-08-25):
    # relative band replaces the old absolute -1e-6 window; scale-free on
    # both metamorphic axes (full rationale in DIFF-NOTE/REVIEW-DECISIONS).
    t_floor = math(value=at_r, value_001=tnow, operation="MAXIMUM")
    fresh = compare(
        a=s_raw,
        b=math(
            value=t_floor,
            value_001=math(value=t_floor, value_001=4.76837158e-07, operation="MULTIPLY"),
            operation="SUBTRACT",
        ),
        operation="GREATER_THAN",
    )

    pos_r_s = vector_math(
        vector=ap_r,
        vector_001=vector_math(vector=vl_r, scale=s_raw - at_r, operation="SCALE"),
        operation="ADD",
    )
    pos_a_s = vector_math(
        vector=ap_a,
        vector_001=vector_math(vector=vl_a, scale=s_raw - at_a, operation="SCALE"),
        operation="ADD",
    )
    pos_b_s = vector_math(
        vector=ap_b,
        vector_001=vector_math(vector=vl_b, scale=s_raw - at_b, operation="SCALE"),
        operation="ADD",
    )
    # DEFECT B FIX (2026-08-25): project in 2D only -- nd's z stays s_raw;
    # mixing anchor times into the projection was the fx11 parity break.
    sep_r = separate_xyz(vector=pos_r_s)
    sep_a2 = separate_xyz(vector=pos_a_s)
    sep_b2 = separate_xyz(vector=pos_b_s)
    pr_xy = combine_xyz(x=sep_r.x, y=sep_r.y, z=0.0)
    pa_xy = combine_xyz(x=sep_a2.x, y=sep_a2.y, z=0.0)
    pb_xy = combine_xyz(x=sep_b2.x, y=sep_b2.y, z=0.0)
    evec = vector_math(vector=pb_xy, vector_001=pa_xy, operation="SUBTRACT")
    elen2 = vector_math(vector=evec, vector_001=evec, operation="DOT_PRODUCT").value
    elen_ok = compare(a=elen2, b=1e-24, operation="GREATER_EQUAL")
    elen2_s = math(value=elen2, value_001=1e-24, operation="MAXIMUM")
    lam = math(
        value=vector_math(
            vector=vector_math(vector=pr_xy, vector_001=pa_xy, operation="SUBTRACT"),
            vector_001=evec,
            operation="DOT_PRODUCT",
        ).value,
        value_001=elen2_s,
        operation="DIVIDE",
    )
    lam_lo = compare(a=lam, b=-1e-7, operation="GREATER_EQUAL")
    lam_hi = compare(a=lam, b=1.0 + 1e-7, operation="LESS_EQUAL")
    adj_a = compare(a=rsl, b=asl, operation="NOT_EQUAL")
    adj_b = compare(a=rsl, b=b_f, operation="NOT_EQUAL")
    # Candidate geometry is valid both for an ordinary same-LAV split and
    # for a reflex front hitting an edge on another LAV.  Hit-edge topology
    # (a/b same LAV and reciprocal pointers) is checked after winner resolve
    # in skel_arbitrate; it must not suppress a genuine cross-LAV merge here.
    ok_base = boolean_math(
        boolean=boolean_math(
            boolean=boolean_math(boolean=den_ok, boolean_001=elen_ok, operation="AND"),
            boolean_001=boolean_math(boolean=lam_lo, boolean_001=lam_hi, operation="AND"),
            operation="AND",
        ),
        boolean_001=boolean_math(
            boolean=adj_a, boolean_001=adj_b, operation="AND"
        ),
        operation="AND",
    )
    ok_all = boolean_math(boolean=ok_base, boolean_001=fresh, operation="AND")
    s_c = switch(switch=ok_all, false=1000000000.0, true=s_raw, input_type="FLOAT")

    at_u = compare(a=lam, b=1e-7, operation="LESS_EQUAL")
    at_w = compare(a=lam, b=1.0 - 1e-7, operation="GREATER_EQUAL")
    cls = switch(
        switch=at_u, false=switch(switch=at_w, false=1.0, true=2.0, input_type="FLOAT"),
        true=0.0, input_type="FLOAT",
    )
    nd = combine_xyz(x=sep_r.x, y=sep_r.y, z=s_raw)

    cls_le1 = compare(a=cls, b=1.5, operation="LESS_EQUAL")
    A_nr = switch(switch=cls_le1, false=nr_b, true=nr_a, input_type="VECTOR")
    A_ed = switch(switch=cls_le1, false=ed_b, true=ed_a, input_type="FLOAT")
    # A's out-edge weight mirrors the A_nr switch (same cls_le1 side pick);
    # the slot stores the weight of its own out-edge (carrier convention).
    A_w = switch(switch=cls_le1, false=w_b, true=w_a, input_type="FLOAT")
    bnx_f = sample_index(geometry=geo, value=f_nx, index=b_i, data_type="FLOAT", domain="POINT")
    A_nx = switch(switch=at_w, false=b_f, true=bnx_f, input_type="FLOAT")
    na_B = switch(switch=at_u, false=nr_a, true=nr_pa, input_type="VECTOR")
    # B's in-edge weight mirrors the na_B switch; B's out-edge IS r's old
    # out-edge, so B's stored weight is w_r.
    B_wp = switch(switch=at_u, false=w_a, true=w_pv_a, input_type="FLOAT")
    B_w = w_r
    B_pv = switch(switch=at_u, false=asl, true=pv_a_f, input_type="FLOAT")
    detA = separate_xyz(
        vector=vector_math(vector=nr_pr, vector_001=A_nr, operation="CROSS_PRODUCT")
    ).z
    detB = separate_xyz(
        vector=vector_math(vector=na_B, vector_001=nr_r, operation="CROSS_PRODUCT")
    ).z
    # vel2 owns every singular limit. Degenerate/antiparallel children remain
    # stationary, while an equal-weight same-direction child keeps the rider
    # velocity proved by P0-R2b. The former outer determinant clamp discarded
    # that valid nonzero split-born velocity before it reached the child.
    A_vl = vel2(na=nr_pr, nb=A_nr, wp=w_pv_r, wq=A_w)
    B_vl = vel2(na=na_B, nb=nr_r, wp=B_wp, wq=B_w)
    return (
        s_c, ok_all,
        s_raw, lam, cls, nd,
        b_f, pv_a_f, pv_r_f, nx_r_f, nr_r,
        ed_r, ed_a, ed_b, ed_pa, lav_r,
        lav_a, pos_a_s, pos_b_s,
        A_nr, A_ed, A_nx, A_vl, A_w,
        B_pv, B_vl, B_w, detA, detB,
    )


@node_tree(id="opus.gnslice.spscore.v1", target="geometry")
def sp_score(
    geo: Geometry, tnow: Float, rsl: Float, asl: Float
) -> Float:
    """Score wrapper (contract S6: 'sp_score (s, valid -- 2 outputs)'). Phase
    1 ships ONE output, s_c: no site consumes a validity flag today (the
    arbitration recomposes validity from det/lav pieces), an unconsumed
    Boolean export would ride every m*n evaluation point, and inertness is
    this pass's only goal. The valid output joins when phase 2 needs the
    lazy-winner gate, with the consumer that uses it.
    Zero math: everything comes from sp_core (dead-name bindings are the
    deliberate-dead dd_sw_* class).
    """
    (
        score_c, d_ok,
        d_s_raw, d_lam, d_cls, d_nd,
        d_b_f, d_pv_a_f, d_pv_r_f, d_nx_r_f, d_nr_r,
        d_ed_r, d_ed_a, d_ed_b, d_ed_pa, d_lav_r,
        d_lav_a, d_pos_a_s, d_pos_b_s,
        d_A_nr, d_A_ed, d_A_nx, d_A_vl, d_A_w,
        d_B_pv, d_B_vl, d_B_w, d_detA, d_detB,
    ) = sp_core(geo=geo, tnow=tnow, rsl=rsl, asl=asl)
    return score_c


@node_tree(id="opus.gnslice.spresolve.v1", target="geometry")
def sp_resolve(
    geo: Geometry, tnow: Float, rsl: Float, asl: Float
) -> tuple[
    Float, Float, Float, Vector,
    Float, Float, Float, Float, Vector,
    Float, Float, Float, Float, Float,
    Float, Vector, Vector,
    Vector, Float, Float, Vector, Float,
    Float, Vector, Float,
    Float, Float,
]:
    """Resolve wrapper: the 27 distinct non-score outputs of the old
    32-tuple, canonical order (see sp_core docstring). Zero math of its
    own -- single sp_core delegation (contract S2/S4).
    """
    (
        d_score_c, d_ok,
        s_raw, lam, cls, nd,
        b_f, pv_a_f, pv_r_f, nx_r_f, nr_r,
        ed_r, ed_a, ed_b, ed_pa, lav_r,
        lav_a, pos_a_s, pos_b_s,
        A_nr, A_ed, A_nx, A_vl, A_w,
        B_pv, B_vl, B_w, detA, detB,
    ) = sp_core(geo=geo, tnow=tnow, rsl=rsl, asl=asl)
    return (
        s_raw, lam, cls, nd,
        b_f, pv_a_f, pv_r_f, nx_r_f, nr_r,
        ed_r, ed_a, ed_b, ed_pa, lav_r,
        lav_a, pos_a_s, pos_b_s,
        A_nr, A_ed, A_nx, A_vl, A_w,
        B_pv, B_vl, B_w, detA, detB,
    )


@node_tree(id="opus.gnslice.rebuild.v1", target="geometry")
def rebuild(
    front: Geometry,
    ap: Vector,
    at: Float,
    vl: Vector,
    nr: Vector,
    ed: Float,
    nx: Float,
    pv: Float,
    lv: Float,
    td: Float,
    bo: Float,
    rf: Float,
    lav: Float,
    w: Float,
) -> Geometry:
    """A5 rebuild carrier: writes the eight front columns from FIELD inputs
    the caller computed against the OLD generation.

    The store order is a MEASURED semantic contract (bisected 2026-08-23,
    rect6x2 maxiter=1 probe): each store's value field re-evaluates every
    unpinned attribute read against the chain state AT THAT STORE. The lv
    field reads pv (keep -> is_head -> ce_prv index=pv_i) and lv (survive ->
    alive); every *_new field reads pv the same way via is_head; pv's own
    value is pinned by sampling f_sm. Therefore lv MUST be stored before pv
    (opus order: lv first, pv last) or chain heads read their NEW pv, find
    ce[new_pv]=1 and die (measured: lv=[0,0,0,0] with lv-last order). The
    terminal-batch freeze is NOT a per-store re-read: the nlive statistic's
    selection evaluates on its own pinned `front` geometry (the previous
    iteration's cloud), so is_term latches one iteration AFTER the batch —
    that delayed latch is the observable freeze. Do not reorder these
    stores; a silent rebind changes solver behavior.
    """
    r1 = store_named_attribute(
        geometry=front, name="lv", value=lv, data_type="FLOAT", domain="POINT"
    )
    r2 = store_named_attribute(
        geometry=r1, name="ap", value=ap, data_type="FLOAT_VECTOR", domain="POINT"
    )
    r3 = store_named_attribute(
        geometry=r2, name="at", value=at, data_type="FLOAT", domain="POINT"
    )
    r4 = store_named_attribute(
        geometry=r3, name="vl", value=vl, data_type="FLOAT_VECTOR", domain="POINT"
    )
    r5 = store_named_attribute(
        geometry=r4, name="nr", value=nr, data_type="FLOAT_VECTOR", domain="POINT"
    )
    r6 = store_named_attribute(
        geometry=r5, name="ed", value=ed, data_type="FLOAT", domain="POINT"
    )
    r7 = store_named_attribute(
        geometry=r6, name="nx", value=nx, data_type="FLOAT", domain="POINT"
    )
    # bo/rf/lav (rung-2) are chain-independent fields (site-cloud samples and
    # plain attribute reads; no f_sm-indexed named reads), so their position
    # in the chain is safe; pv stays LAST.
    r_bo = store_named_attribute(
        geometry=r7, name="bo", value=bo, data_type="FLOAT", domain="POINT"
    )
    r_rf = store_named_attribute(
        geometry=r_bo, name="rf", value=rf, data_type="FLOAT", domain="POINT"
    )
    r_lav = store_named_attribute(
        geometry=r_rf, name="lav", value=lav, data_type="FLOAT", domain="POINT"
    )
    # w is chain-independent like bo/rf/lav (plain field input pinned by the
    # caller's w_g fold; no f_sm-indexed reads inside rebuild).
    r_w = store_named_attribute(
        geometry=r_lav, name="w", value=w, data_type="FLOAT", domain="POINT"
    )
    r8 = store_named_attribute(
        geometry=r_w, name="td", value=td, data_type="FLOAT", domain="POINT"
    )
    return store_named_attribute(
        geometry=r8, name="pv", value=pv, data_type="FLOAT", domain="POINT"
    )


@node_tree(id="opus.gnslice.collapse.v1", target="geometry")
def skel_collapse(
    front: Geometry,
    ap: Vector,
    at: Float,
    vl: Vector,
    alive: Boolean,
    nx_i: Integer,
    tnow: Float,
) -> tuple[Float, Boolean]:
    """S3 edge-event candidate field (structural revision S6 step 1).

    Pure field math: no stores and no unpinned attribute reads inside —
    the caller resolves ap/at/vl/alive once on the zone-input front and
    passes them in ("pass the value" idiom, grove authoring.md store-order
    law), and ap_j/at_j/vl_j stay sample-pinned to `front`, so the pin
    inventory is unchanged across the group boundary (contract S5 inv 2).
    Every S3 local other than `cand` was zone-local only (consumer grep
    2026-08-26); the S4 min-statistic stays in the zone.
    """
    ap_j = sample_index(
        geometry=front, value=ap, index=nx_i, data_type="FLOAT_VECTOR", domain="POINT"
    )
    at_j = sample_index(
        geometry=front, value=at, index=nx_i, data_type="FLOAT", domain="POINT"
    )
    vl_j = sample_index(
        geometry=front, value=vl, index=nx_i, data_type="FLOAT_VECTOR", domain="POINT"
    )
    base_i = vector_math(
        vector=ap,
        vector_001=vector_math(vector=vl, scale=at, operation="SCALE"),
        operation="SUBTRACT",
    )
    base_j = vector_math(
        vector=ap_j,
        vector_001=vector_math(vector=vl_j, scale=at_j, operation="SCALE"),
        operation="SUBTRACT",
    )
    d_vel = vector_math(vector=vl_j, vector_001=vl, operation="SUBTRACT")
    d_base = vector_math(vector=base_j, vector_001=base_i, operation="SUBTRACT")
    den = vector_math(
        vector=d_vel, vector_001=d_vel, operation="DOT_PRODUCT"
    ).value
    num = vector_math(
        vector=d_base, vector_001=d_vel, operation="DOT_PRODUCT"
    ).value
    t_raw = (num * -1.0) / math(value=den, value_001=1e-12, operation="MAXIMUM")
    ok_den = compare(a=den, b=1e-10, operation="GREATER_THAN")
    # D1 freshness, edge-event side (2026-08-23 sweep; task #14
    # mechanism 2, AMENDED 2026-08-25): an edge event at s == tnow
    # must stay visible the iteration AFTER a simultaneous split
    # fired — the old strictly-future gate made it invisible and
    # asymmetric double-notch rings burned the whole budget
    # (measured sw05/07/11/15/17/23: 16 iters, code 2, 0 faces;
    # oracle: 9 scans). Same mechanism as the split side after the
    # amendment: relative below-side band, floor - floor*2^-21, on
    # the pair floor (max of both endpoints' at and the clock).
    # There is no is_lead loser on this side to carry a state bit,
    # which is exactly why the band (not state) owns readmission
    # here; see the split-gate comment and DEAD-ENDS.md entries 1-5
    # for the amendment trail and the Codex consult receipt.
    at_pair = math(
        value=math(value=at, value_001=at_j, operation="MAXIMUM"),
        value_001=tnow,
        operation="MAXIMUM",
    )
    ok_fut = compare(
        a=t_raw,
        b=math(
            value=at_pair,
            value_001=math(value=at_pair, value_001=4.76837158e-07, operation="MULTIPLY"),
            operation="SUBTRACT",
        ),
        operation="GREATER_EQUAL",
    )
    # K1: closest approach is an admissible edge-event candidate only when
    # the two endpoint trajectories actually meet in XY at t_raw. Keep this
    # classification separate from candidate admission: the root uses it
    # solely to defer a co-band phantom for one split iteration.
    res_v = vector_math(
        vector=d_base,
        vector_001=vector_math(vector=d_vel, scale=t_raw, operation="SCALE"),
        operation="ADD",
    )
    res_s = separate_xyz(vector=res_v)
    res2 = res_s.x * res_s.x + res_s.y * res_s.y
    db_s = separate_xyz(vector=d_base)
    db2 = db_s.x * db_s.x + db_s.y * db_s.y
    ok_meet = compare(
        a=res2,
        b=math(value=db2, value_001=1.0, operation="MAXIMUM") * 1e-8,
        operation="LESS_EQUAL",
    )
    ok_both = boolean_math(boolean=ok_den, boolean_001=ok_fut, operation="AND")
    ok_all = boolean_math(boolean=ok_both, boolean_001=alive, operation="AND")
    return (
        switch(switch=ok_all, false=1000000000.0, true=t_raw, input_type="FLOAT"),
        ok_meet,
    )


@node_tree(id="opus.gnslice.split_scan.v1", target="geometry")
def skel_split_scan(
    front: Geometry, alive: Boolean, z_idx: Float, nlive: Float, tnow: Float,
) -> tuple[
    Geometry, Float,
    Float, Float,
    Float, Float, Float, Float, Float, Float, Float, Float, Float, Float,
    Float,
]:
    """Split scan (S7a-I): pair cloud -> per-reflex argmin (P11).

    Whole-chain move (revision contract S2, "split_scan" stage def): the
    `six` store, both ranked slot curves, the m*n pair cloud, both
    `_sp_scan` instances, and the `sc`/`sev` site bakes all relocate
    TOGETHER, so every in-def consumer of a stored field still sits
    downstream of its own store — no cross-boundary store-order hazard is
    introduced (authoring.md store-order law). Reads `rf` by name (field
    on `front`, evaluated where consumed — unchanged). The three explicit
    `sample_index` geometry pins (rf_curve, al_curve, pair_cur) move with
    their geometries; the pin inventory is unchanged. The 11 returned
    `sw_*` fields are the ARBITRATION reads (pre-delete, row-aligned with
    `s_st`); post-delete consumers read the baked `sc`/`sev` attributes.
    """
    rf_f = input_named_attribute(name="rf", data_type="FLOAT")
    is_rf = boolean_math(
        boolean=alive,
        boolean_001=compare(a=rf_f, b=0.5, operation="GREATER_THAN"),
        operation="AND",
    )
    m_ref = attribute_statistic(
        geometry=front,
        selection=is_rf,
        attribute=1.0,
        data_type="FLOAT",
        domain="POINT",
    ).sum
    pool_ix = store_named_attribute(
        geometry=front, name="six", value=z_idx, data_type="FLOAT", domain="POINT"
    )
    six_f = input_named_attribute(name="six", data_type="FLOAT")
    rf_del = delete_geometry(
        geometry=pool_ix,
        selection=boolean_math(boolean=is_rf, operation="NOT"),
        mode="ALL",
        domain="POINT",
    )
    rf_key = set_position(geometry=rf_del, position=(six_f, 0.0, 0.0))
    rf_curve = points_to_curves(
        points=rf_key, curve_group_id=0, weight=six_f
    )
    al_del = delete_geometry(
        geometry=pool_ix,
        selection=boolean_math(boolean=alive, operation="NOT"),
        mode="ALL",
        domain="POINT",
    )
    al_key = set_position(geometry=al_del, position=(six_f, 0.0, 0.0))
    al_curve = points_to_curves(
        points=al_key, curve_group_id=0, weight=six_f
    )
    # Pair cloud p = m*n points: reflex rank ri = p div n, edge rank
    # ei = p mod n (n = nlive). Mechanism 4 (task #14): the pair
    # arbitration key is s ALONE. The Points-to-Curves weight sorts
    # each curve ascending with a STABLE tie order (Blender 5.2
    # manual, points_to_curves.html#inputs: equal-weight points keep
    # their original relative location), and within a reflex group
    # the input order IS a_slot ascending — so min-weight-first +
    # stable ties = true lexicographic (s, a_slot), matching the
    # oracle's (s, code, x, y, uid) sort falling back to
    # edge-creation order. The retired additive credit
    # s + a_slot*2^-20 INVERTED this order whenever
    # 0 < ds < D_slot*2^-20 (D_slot*2^-20 ~ 1e-5 vs the ~1e-4
    # corpus separations — immune on the frozen basis, WRONG by
    # construction): fx11_key_inversion (RED, constructed
    # ds = 4.25e-6 in the window, parents 0/4, rank gap 9) —
    # search_key_inversion{,2,3,4,5}.py + KEY-INVERSION-SEARCH.txt.
    pair_n_i = float_to_int(
        float=math(value=m_ref, value_001=nlive, operation="MULTIPLY"),
        rounding_mode="ROUND",
    )
    pair_c = points(count=pair_n_i)
    p_ri = math(
        value=math(value=z_idx, value_001=nlive, operation="DIVIDE"),
        operation="FLOOR",
    )
    p_ei = math(value=z_idx, value_001=nlive, operation="MODULO")
    p_ri_i = float_to_int(float=p_ri, rounding_mode="ROUND")
    p_ei_i = float_to_int(float=p_ei, rounding_mode="ROUND")
    rsl_p = separate_xyz(
        vector=sample_index(
            geometry=rf_curve, value=input_position(), index=p_ri_i,
            data_type="FLOAT_VECTOR", domain="POINT",
        )
    ).x
    asl_p = separate_xyz(
        vector=sample_index(
            geometry=al_curve, value=input_position(), index=p_ei_i,
            data_type="FLOAT_VECTOR", domain="POINT",
        )
    ).x
    # Re-cut (contract S2): the m*n pair cloud scores only -- sp_score,
    # one shared-math delegation per row. Everything else this stage needs
    # comes back through the winner site's sp_resolve below.
    pw_s_c = sp_score(geo=front, tnow=tnow, rsl=rsl_p, asl=asl_p)
    pair_keyed = set_position(
        geometry=pair_c, position=(rsl_p, asl_p, 0.0)
    )
    # Mechanism 4: weight = s ALONE. Points-to-Curves sorts each
    # curve ascending and keeps equal-weight points in original
    # relative location (5.2 manual, points_to_curves.html#inputs),
    # and within a reflex group the pair-cloud input order is
    # a_slot ascending — so min-s-first + stable ties IS the true
    # lexicographic (s, a_slot) arbitration.
    pair_cur = points_to_curves(
        points=pair_keyed, curve_group_id=p_ri_i, weight=pw_s_c
    )
    # Sites: one per reflex — curve g's control point 0 (global index
    # g*n) is that reflex's argmin pair; positions carry (r_slot, a_slot).
    m_i = float_to_int(float=m_ref, rounding_mode="ROUND")
    sites_c = points(count=m_i)
    arg_pos = sample_index(
        geometry=pair_cur, value=input_position(),
        index=float_to_int(
            float=math(value=z_idx, value_001=nlive, operation="MULTIPLY"),
            rounding_mode="ROUND",
        ),
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    arg_sep = separate_xyz(vector=arg_pos)
    # Re-cut: the winner row keeps its consumed column subset via
    # sp_resolve; sc comes through the score wrapper (one shared-core
    # delegation each, zero wrapper-local math).
    sw_s_c = sp_score(geo=front, tnow=tnow, rsl=arg_sep.x, asl=arg_sep.y)
    (
        dd_sw_s_raw, dd_sw_lam, sw_cls, sw_nd, sw_b_f,
        sw_pv_a_f, sw_pv_r_f, sw_nx_r_f, dd_sw_nr_r, dd_sw_ed_r,
        dd_sw_ed_a, dd_sw_ed_b, dd_sw_ed_pa, sw_lav_r, sw_lav_a,
        dd_sw_pos_a_s, dd_sw_pos_b_s,
        dd_sw_A_nr, dd_sw_A_ed, sw_A_nx, dd_sw_A_vl, dd_sw_A_w,
        dd_sw_B_pv, dd_sw_B_vl, dd_sw_B_w, sw_detA, sw_detB,
    ) = sp_resolve(geo=front, tnow=tnow, rsl=arg_sep.x, asl=arg_sep.y)
    sites_pos = set_position(
        geometry=sites_c, position=(arg_sep.x, arg_sep.y, 0.0)
    )
    s_sc = store_named_attribute(
        geometry=sites_pos, name="sc", value=sw_s_c, data_type="FLOAT", domain="POINT"
    )
    # Bake the site's split-event vector BEFORE any row deletion. The sw_*
    # scan fields are keyed by input_index() on the CONSUMING geometry, so
    # a post-delete consumer (the arbitration cloud) re-evaluates them
    # against COMPACTED indices and reads the wrong row's event — measured
    # sw05: surviving accept row's sw_nd.x flipped 4.5178 -> 7.1997
    # (pair_cur[0]) after its sibling failed accept, freezing is_lead
    # false forever. A named attribute travels with the row through
    # delete_geometry.
    s_st = store_named_attribute(
        geometry=s_sc, name="sev", value=sw_nd,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    t_min_s_raw = attribute_statistic(
        geometry=s_st,
        attribute=input_named_attribute(name="sc", data_type="FLOAT"),
        data_type="FLOAT",
        domain="POINT",
    ).min
    has_rf = compare(a=m_ref, b=0.5, operation="GREATER_THAN")
    t_min_s = switch(
        switch=has_rf, false=1000000000.0, true=t_min_s_raw, input_type="FLOAT"
    )
    # arg_r/arg_a: separate components, NOT the Vector — a def-call return
    # is a group output socket, and `.x` attribute access does not resolve
    # on those (compile error). The components are bound here where the
    # SeparateXYZ result is still a plain node value.
    arg_r = arg_sep.x
    arg_a = arg_sep.y
    return (
        s_st, t_min_s, arg_r, arg_a, sw_s_c, sw_cls, sw_b_f, sw_pv_a_f,
        sw_pv_r_f, sw_nx_r_f, sw_A_nx, sw_lav_r, sw_lav_a, sw_detA, sw_detB,
    )


@node_tree(id="opus.gnslice.edge_batch.v1", target="geometry")
def skel_edge_batch(
    front: Geometry, alive: Boolean, cand: Float, t_min: Float,
    nlive: Float, maxiter: Integer, pv_i: Integer,
) -> tuple[
    Geometry, Geometry, Geometry,
    Boolean, Boolean, Boolean,
    Float, Float,
    Boolean, Boolean, Boolean,
    Float, Float, Float, Float, Float, Float,
]:
    """Edge-event batch (tie band -> ce mask -> sm/dy chases).

    Whole-chain move (revision contract S2, arbitrate cut 3a of 2): the
    `ce` store, both chase walks (which store sm/hd), and the dying-mask
    branch all relocate TOGETHER; the unpinned ce read in the f_dy store
    still sees chain input f_ce (store-order law, documented in-source).
    The returned Bool/Float fields (ce_b2, dying, not_cep, sm_f, hd_f,
    dy_f, sdy_hd_f, pv_fa, ce_f2) are named-attribute fields — they
    re-evaluate on the CONSUMER's chain state across the group boundary,
    byte-equivalent to the in-zone bindings (same propagation _sp_scan
    already relies on).
    """
    no_event = compare(a=t_min, b=500000000.0, operation="GREATER_THAN")
    # Mechanism 3 (task #14): the tie band is PURELY RELATIVE —
    # the legacy +1e-6 absolute term dominated t*1e-5 whenever
    # t < ~0.1 (at t ~ 2.4e-6 it widened the band to ~40% relative,
    # the measured c=1e5 11->10 arc loss). Inside the declared
    # input window (win_bad above) relative width 1e-5 holds at
    # every attainable t; the window bounds what we do not claim.
    tie_thr = t_min * 1.00001
    is_tie = compare(a=cand, b=tie_thr, operation="LESS_EQUAL")
    # Code 5 (ambiguous_extent_band) — edge side: boundary-adjacency
    # detector on the SAME population the batch gate sees. A candidate
    # within one f32 ulp of tie_thr can flip is_tie under quantization,
    # so batch membership (and the solve) is luck, not math — report 5
    # instead of silently batching. Exact-tie members sit at t_min,
    # >= ~83 ulps below the boundary (band = t*1e-5 vs ulp ~
    # t*1.2e-7), so ordinary ties never trip this; sentinel candidates
    # (1e9) are far outside by construction.
    amb5_e_diff = math(value=cand, value_001=tie_thr, operation="SUBTRACT")
    amb5_e_row = boolean_math(
        boolean=alive,
        boolean_001=compare(
            a=math(value=amb5_e_diff, operation="ABSOLUTE"),
            b=math(value=tie_thr, value_001=1.1920928955078125e-07, operation="MULTIPLY"),
            operation="LESS_EQUAL",
        ),
        operation="AND",
    )
    amb5_e_sum = attribute_statistic(
        geometry=front, selection=amb5_e_row, attribute=1.0,
        data_type="FLOAT", domain="POINT",
    ).sum
    amb5_e = compare(a=amb5_e_sum, b=0.5, operation="GREATER_THAN")
    # 3-ring forced batch REMOVED (2026-08-23, endpoint-kill unit): the
    # old `ce_or = is_tie OR ring3_b` killed every live 3-ring member at
    # the CURRENT clock the iteration after the ring formed, even when
    # the ring's own edges collapse later. Measured sw00: the left split
    # (t=0.8999) cuts the LAV into the 3-ring {0,10,8}; next iteration
    # t_min is still 0.8999 (mirror split re-derives at the same t), so
    # all three died at split-time positions — phantom terminals
    # (0.8999,0.8999,0.8999)/(0.8999,1.0262,0.8999) where the oracle
    # walks them to their own events (mitre merge 0.9127). The oracle
    # has NO ring-size rule: members die via their edge events (is_tie)
    # and the ring shrinks 3->2->cap. Every fixture 3-ring that passed
    # before was already co-timed with its own collapse, so is_tie
    # covers the whole corpus on its own.
    ce_b = boolean_math(boolean=is_tie, boolean_001=alive, operation="AND")
    ce_v = switch(switch=ce_b, false=0.0, true=1.0, input_type="FLOAT")
    f_ce = store_named_attribute(
        geometry=front, name="ce", value=ce_v, data_type="FLOAT", domain="POINT"
    )
    f_sm = chase(front=f_ce, steps=maxiter)

    ce_f2 = input_named_attribute(name="ce", data_type="FLOAT")
    sm_f = input_named_attribute(name="sm", data_type="FLOAT")
    hd_f = input_named_attribute(name="hd", data_type="FLOAT")
    ce_b2 = compare(a=ce_f2, b=0.5, operation="GREATER_THAN")
    ce_prv = sample_index(
        geometry=f_sm, value=ce_f2, index=pv_i, data_type="FLOAT", domain="POINT"
    )
    ce_pb = compare(a=ce_prv, b=0.5, operation="GREATER_THAN")
    not_cep = boolean_math(boolean=ce_pb, operation="NOT")
    dies_or = boolean_math(boolean=ce_b2, boolean_001=ce_pb, operation="OR")
    dying = boolean_math(boolean=dies_or, boolean_001=alive, operation="AND")
    # Dying-mask chase (fx4/fx5): `ce` flags only each collapsing edge's
    # HEAD slot (cand is per-slot on its own outgoing edge); the partner
    # dies via ce at its pv, which the ce-based sm/hd walks never cross.
    # Virtual-merge retargets need the FULL dead run, so re-run chase on
    # a branch of f_ce with "ce" overwritten by the dying mask (the
    # store value's unpinned ce read sees the chain input f_ce, whose
    # ce is still the head mask — correct per the store-order law).
    dy_v = switch(switch=dying, false=0.0, true=1.0, input_type="FLOAT")
    f_dy = store_named_attribute(
        geometry=f_ce, name="ce", value=dy_v, data_type="FLOAT", domain="POINT"
    )
    f_sdy = chase(front=f_dy, steps=maxiter)
    dy_f = input_named_attribute(name="ce", data_type="FLOAT")
    sdy_sm_f = input_named_attribute(name="sm", data_type="FLOAT")
    sdy_hd_f = input_named_attribute(name="hd", data_type="FLOAT")
    pv_fa = input_named_attribute(name="pv", data_type="FLOAT")
    n_col = attribute_statistic(
        geometry=f_sm,
        selection=ce_b2,
        attribute=1.0,
        data_type="FLOAT",
        domain="POINT",
    ).sum
    total_col = compare(a=n_col, b=nlive - 0.5, operation="GREATER_THAN")
    return (
        f_sm, f_dy, f_sdy, no_event, amb5_e, total_col, tie_thr, ce_f2,
        ce_b2, dying, not_cep, sm_f, hd_f, dy_f, sdy_sm_f, sdy_hd_f, pv_fa,
    )


@node_tree(id="opus.gnslice.arbitrate.v1", target="geometry")
def skel_arbitrate(
    front: Geometry, s_st: Geometry,
    arg_r: Float, arg_a: Float,
    sw_s_c: Float, sw_cls: Float, sw_b_f: Float, sw_pv_a_f: Float,
    sw_pv_r_f: Float, sw_nx_r_f: Float, sw_a_nx: Float,
    sw_lav_a: Float, sw_deta: Float, sw_detb: Float,
    f_sm: Geometry, f_dy: Geometry, f_sdy: Geometry,
    ce_f2: Float, dy_f: Float, sdy_hd_f: Float, pv_fa: Float,
    tie_thr: Float, bc: Float, z_idx: Float,
) -> tuple[
    Geometry, Geometry,
    Float, Boolean, Boolean, Float, Integer, Float,
    Boolean, Boolean, Boolean, Boolean, Boolean,
    Float, Float, Float, Float, Float, Float, Float, Float, Float, Float,
    Float,
]:
    """Site acceptance + dispatch (S7a-II, arbitrate cut 3b of 2).

    No stores; the two delete compactions (acc_arb, sites_acc) ride the
    baked `sc`/`sev` attributes on s_st, and the srk/srk_pts index-keyed
    twins keep their pinned sample_index reads (documented safe idiom).
    The returned per-site Boolean fields (pre_core, det_bad, det_ok,
    xlav_b, amb5_s_row) re-evaluate on the consumer's chain state —
    consumed on s_st rows in the error-carrier scans, row-aligned by
    construction. ps_f stays in-def (ps0_f resolve); the newborn-stage
    `ps` read re-binds at its own consumer.
    """
    ncor_f = input_named_attribute(name="ncor", data_type="FLOAT")
    ps_f = input_named_attribute(name="ps", data_type="FLOAT")
    lav_fa = input_named_attribute(name="lav", data_type="FLOAT")
    N_f = sample_index(
        geometry=front, value=ncor_f, index=0, data_type="FLOAT", domain="POINT"
    )
    ps0_f = sample_index(
        geometry=front, value=ps_f, index=0, data_type="FLOAT", domain="POINT"
    )
    r_i_s = float_to_int(float=arg_r, rounding_mode="ROUND")
    a_i_s = float_to_int(float=arg_a, rounding_mode="ROUND")
    b_i_s = float_to_int(float=sw_b_f, rounding_mode="ROUND")
    sw_lav_b = sample_index(
        geometry=front, value=lav_fa, index=b_i_s,
        data_type="FLOAT", domain="POINT",
    )
    live_lav_a = sample_index(
        geometry=front, value=lav_fa, index=a_i_s,
        data_type="FLOAT", domain="POINT",
    )
    sw_pv_b = sample_index(
        geometry=front, value=pv_fa, index=b_i_s,
        data_type="FLOAT", domain="POINT",
    )
    ce_a = sample_index(geometry=f_sm, value=ce_f2, index=a_i_s, data_type="FLOAT", domain="POINT")
    ce_bs = sample_index(
        geometry=f_sm, value=ce_f2,
        index=float_to_int(float=sw_b_f, rounding_mode="ROUND"),
        data_type="FLOAT", domain="POINT",
    )
    # Supersession = the oracle's split guard (skeleton_oracle.py
    # 661-688): a split dies only if r dies, or the hit edge itself
    # collapses (BOTH endpoints merging with each other). "r dies" is the
    # FULL dying mask at r — dying(r) = ce(r) ∨ ce(pv(r)) is exactly "an
    # edge adjacent to r collapses", i.e. oracle ¬r.alive: r is replaced
    # by a merge even when it is the run's reborn head, and fx6's r dies
    # as the non-head partner (ce(r)=0, ce(pv(r))=1) which the head-only
    # ce_r form misses. An endpoint dying via merge-REPLACEMENT re-links
    # the edge to the new vertex, which lies on the hit edge's offset
    # line at t — the old-gen split point is exactly what the oracle
    # re-derives (fx4/fx5), so the hit-edge term stays both-endpoints.
    dy_r = sample_index(
        geometry=f_dy, value=dy_f, index=r_i_s, data_type="FLOAT", domain="POINT"
    )
    sup_b = boolean_math(
        boolean=compare(a=dy_r, b=0.5, operation="GREATER_THAN"),
        boolean_001=boolean_math(
            boolean=compare(a=ce_a, b=0.5, operation="GREATER_THAN"),
            boolean_001=compare(a=ce_bs, b=0.5, operation="GREATER_THAN"),
            operation="AND",
        ),
        operation="OR",
    )
    # Degenerate child (fx4/fx5): after virtual-merge retargeting the
    # child's nx and pv land on the SAME slot — a 2-ring with the batch's
    # reborn merge head (the rung-1 rebirth folds the virtual merge
    # vertex INTO the head slot, so the oracle's {child, virtual} LAV is
    # an ordinary live 2-ring here; the ring2 caps emit its terminal
    # arcs). That child's flanking walls are parallel (a = pv(r) at an
    # adjacent-edge interior split, fx4) or opposed (at-u split, fx5),
    # so its bisector det vanishes BY GEOMETRY — the det gate excuses
    # exactly this child. Healthy splits keep nx != pv (distinct live
    # slots), so the excuse is self-invalidating on them.
    hdw_i = float_to_int(float=sw_pv_r_f, rounding_mode="ROUND")
    a_pv_rt = switch(
        switch=compare(
            a=sample_index(geometry=f_dy, value=dy_f, index=hdw_i, data_type="FLOAT", domain="POINT"),
            b=0.5, operation="GREATER_THAN",
        ),
        false=sw_pv_r_f,
        true=sample_index(geometry=f_sdy, value=sdy_hd_f, index=hdw_i, data_type="FLOAT", domain="POINT"),
        input_type="FLOAT",
    )
    deg_w_b = compare(a=sw_a_nx, b=a_pv_rt, operation="EQUAL")
    # B pairs with the pv-run's reborn head whenever that run dies. The
    # patch and fold stages must target the same holder; walking past the
    # head here leaves q.nx and B.pv individually in bounds but mutually
    # non-reciprocal on the mirrored exact-equality event.
    b_cls0 = compare(a=sw_cls, b=0.5, operation="LESS_EQUAL")
    b_pv_src = switch(switch=b_cls0, false=arg_a, true=sw_pv_a_f, input_type="FLOAT")
    b_pv_i = float_to_int(float=b_pv_src, rounding_mode="ROUND")
    b_pv_hd = sample_index(
        geometry=f_sdy, value=sdy_hd_f, index=b_pv_i, data_type="FLOAT", domain="POINT"
    )
    b_pv_rt = switch(
        switch=compare(
            a=sample_index(geometry=f_dy, value=dy_f, index=b_pv_i, data_type="FLOAT", domain="POINT"),
            b=0.5, operation="GREATER_THAN",
        ),
        false=b_pv_src,
        true=b_pv_hd,
        input_type="FLOAT",
    )
    deg_u_b = compare(a=sw_nx_r_f, b=b_pv_rt, operation="EQUAL")
    sup_ok = boolean_math(boolean=sup_b, operation="NOT")
    base_ok = compare(a=sw_s_c, b=500000000.0, operation="LESS_THAN")
    tie_ok = compare(a=sw_s_c, b=tie_thr, operation="LESS_EQUAL")
    # Code 5 split side: a real split candidate (base_ok filters the
    # 1e9 sentinel) within one f32 ulp of the band boundary — its
    # tie_ok membership is quantization luck (edge-side note above).
    amb5_s_diff = math(value=sw_s_c, value_001=tie_thr, operation="SUBTRACT")
    amb5_s_row = boolean_math(
        boolean=base_ok,
        boolean_001=compare(
            a=math(value=amb5_s_diff, operation="ABSOLUTE"),
            b=math(value=tie_thr, value_001=1.1920928955078125e-07, operation="MULTIPLY"),
            operation="LESS_EQUAL",
        ),
        operation="AND",
    )
    # A valid candidate is either an ordinary same-LAV split or a cross-LAV
    # merge.  Code 6 is reserved for a corrupt hit edge: a and b disagree on
    # LAV membership or b does not point back to a.  Slot/LAV ids are integer
    # valued floats, so > 0.5 is an exact inequality test without Epsilon.
    ab_lav_bad = compare(
        a=math(
            value=sw_lav_a, value_001=sw_lav_b, operation="SUBTRACT"
        ),
        b=0.5,
        operation="GREATER_THAN",
    )
    ab_lav_bad_neg = compare(
        a=math(
            value=sw_lav_b, value_001=sw_lav_a, operation="SUBTRACT"
        ),
        b=0.5,
        operation="GREATER_THAN",
    )
    pv_b_bad = compare(
        a=math(value=sw_pv_b, value_001=arg_a, operation="SUBTRACT"),
        b=0.5,
        operation="GREATER_THAN",
    )
    pv_b_bad_neg = compare(
        a=math(value=arg_a, value_001=sw_pv_b, operation="SUBTRACT"),
        b=0.5,
        operation="GREATER_THAN",
    )
    xlav_b = boolean_math(
        boolean=boolean_math(
            boolean=ab_lav_bad, boolean_001=ab_lav_bad_neg, operation="OR"
        ),
        boolean_001=boolean_math(
            boolean=pv_b_bad, boolean_001=pv_b_bad_neg, operation="OR"
        ),
        operation="OR",
    )
    # det guard (code 4), per-side excuse: detA belongs to child A (w
    # side), detB to child B (u side).  Besides the retained virtual-merge
    # 2-ring case, a valid split may birth an antiparallel child: the owned
    # referee keeps that stationary (zero velocity, non-reflex) until nook
    # closure consumes it.  This remains true after a first cross-LAV merge
    # relabels later same-time splits onto one LAV. Equal-weight,
    # same-direction riders use vel2's proved nonzero singular limit.
    nr_fa = input_named_attribute(name="nr", data_type="FLOAT_VECTOR")
    w_fa = input_named_attribute(name="w", data_type="FLOAT")
    nr_r_det = sample_index(
        geometry=front, value=nr_fa, index=r_i_s,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    nr_pr_det = sample_index(
        geometry=front, value=nr_fa,
        index=float_to_int(float=sw_pv_r_f, rounding_mode="ROUND"),
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    nr_a_det = sample_index(
        geometry=front, value=nr_fa, index=a_i_s,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    nr_b_det = sample_index(
        geometry=front, value=nr_fa, index=b_i_s,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    nr_pa_det = sample_index(
        geometry=front, value=nr_fa,
        index=float_to_int(float=sw_pv_a_f, rounding_mode="ROUND"),
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    cls_le1_det = compare(a=sw_cls, b=1.5, operation="LESS_EQUAL")
    at_u_det = compare(a=sw_cls, b=0.5, operation="LESS_EQUAL")
    A_nr_det = switch(
        switch=cls_le1_det, false=nr_b_det, true=nr_a_det, input_type="VECTOR"
    )
    na_B_det = switch(
        switch=at_u_det, false=nr_a_det, true=nr_pa_det, input_type="VECTOR"
    )
    w_r_det = sample_index(
        geometry=front, value=w_fa, index=r_i_s,
        data_type="FLOAT", domain="POINT",
    )
    w_pr_det = sample_index(
        geometry=front, value=w_fa,
        index=float_to_int(float=sw_pv_r_f, rounding_mode="ROUND"),
        data_type="FLOAT", domain="POINT",
    )
    w_a_det = sample_index(
        geometry=front, value=w_fa, index=a_i_s,
        data_type="FLOAT", domain="POINT",
    )
    w_b_det = sample_index(
        geometry=front, value=w_fa, index=b_i_s,
        data_type="FLOAT", domain="POINT",
    )
    w_pa_det = sample_index(
        geometry=front, value=w_fa,
        index=float_to_int(float=sw_pv_a_f, rounding_mode="ROUND"),
        data_type="FLOAT", domain="POINT",
    )
    A_w_det = switch(
        switch=cls_le1_det, false=w_b_det, true=w_a_det, input_type="FLOAT"
    )
    B_wp_det = switch(
        switch=at_u_det, false=w_a_det, true=w_pa_det, input_type="FLOAT"
    )
    detA_zero = compare(
        a=math(value=sw_deta, operation="ABSOLUTE"),
        b=1e-12,
        operation="LESS_THAN",
    )
    detB_zero = compare(
        a=math(value=sw_detb, operation="ABSOLUTE"),
        b=1e-12,
        operation="LESS_THAN",
    )
    anti_A = boolean_math(
        boolean=detA_zero,
        boolean_001=compare(
            a=vector_math(
                vector=nr_pr_det, vector_001=A_nr_det, operation="DOT_PRODUCT"
            ).value,
            b=0.0,
            operation="LESS_THAN",
        ),
        operation="AND",
    )
    anti_B = boolean_math(
        boolean=detB_zero,
        boolean_001=compare(
            a=vector_math(
                vector=na_B_det, vector_001=nr_r_det, operation="DOT_PRODUCT"
            ).value,
            b=0.0,
            operation="LESS_THAN",
        ),
        operation="AND",
    )
    rider_A = boolean_math(
        boolean=boolean_math(
            boolean=detA_zero,
            boolean_001=compare(
                a=vector_math(
                    vector=nr_pr_det, vector_001=A_nr_det, operation="DOT_PRODUCT"
                ).value,
                b=0.0,
                operation="GREATER_THAN",
            ),
            operation="AND",
        ),
        boolean_001=compare(
            a=math(value=w_pr_det - A_w_det, operation="ABSOLUTE"),
            b=0.0,
            operation="LESS_EQUAL",
        ),
        operation="AND",
    )
    rider_B = boolean_math(
        boolean=boolean_math(
            boolean=detB_zero,
            boolean_001=compare(
                a=vector_math(
                    vector=na_B_det, vector_001=nr_r_det, operation="DOT_PRODUCT"
                ).value,
                b=0.0,
                operation="GREATER_THAN",
            ),
            operation="AND",
        ),
        boolean_001=compare(
            a=math(value=B_wp_det - w_r_det, operation="ABSOLUTE"),
            b=0.0,
            operation="LESS_EQUAL",
        ),
        operation="AND",
    )
    detA_ok = boolean_math(
        boolean=boolean_math(
            boolean=compare(
                a=math(value=sw_deta, operation="ABSOLUTE"),
                b=1e-12,
                operation="GREATER_EQUAL",
            ),
            boolean_001=deg_w_b,
            operation="OR",
        ),
        boolean_001=boolean_math(
            boolean=anti_A, boolean_001=rider_A, operation="OR"
        ),
        operation="OR",
    )
    detB_ok = boolean_math(
        boolean=boolean_math(
            boolean=compare(
                a=math(value=sw_detb, operation="ABSOLUTE"),
                b=1e-12,
                operation="GREATER_EQUAL",
            ),
            boolean_001=deg_u_b,
            operation="OR",
        ),
        boolean_001=boolean_math(
            boolean=anti_B, boolean_001=rider_B, operation="OR"
        ),
        operation="OR",
    )
    det_ok = boolean_math(boolean=detA_ok, boolean_001=detB_ok, operation="AND")
    pre_core = boolean_math(
        boolean=boolean_math(boolean=base_ok, boolean_001=tie_ok, operation="AND"),
        boolean_001=sup_ok,
        operation="AND",
    )
    det_bad = boolean_math(boolean=det_ok, operation="NOT")
    accept_pre = boolean_math(
        boolean=pre_core,
        boolean_001=boolean_math(
            boolean=boolean_math(boolean=xlav_b, operation="NOT"),
            boolean_001=det_ok,
            operation="AND",
        ),
        operation="AND",
    )
    n_acc_pre = attribute_statistic(
        geometry=s_st, selection=accept_pre, attribute=1.0, data_type="FLOAT", domain="POINT"
    ).sum
    # D1-sweep debug counters (livelock triage, sw05 class): per-stage
    # site pass counts, exported on the output carriers as gn_gate_a/b.
    # Frozen-state livelocks repeat one iteration forever, so the EXIT
    # iteration's counters diagnose every stuck iteration.
    dbg_b = attribute_statistic(
        geometry=s_st, selection=base_ok, attribute=1.0, data_type="FLOAT", domain="POINT"
    ).sum
    dbg_c = attribute_statistic(
        geometry=s_st, selection=pre_core, attribute=1.0, data_type="FLOAT", domain="POINT"
    ).sum
    cap_ok = compare(
        a=math(
            value=math(value=N_f, value_001=bc, operation="ADD"),
            value_001=n_acc_pre,
            operation="ADD",
        ),
        b=ps0_f + 0.5,
        operation="LESS_THAN",
    )
    accept = boolean_math(boolean=accept_pre, boolean_001=cap_ok, operation="AND")
    # Split relinks are sequential in the accepted referee: apply one, relabel
    # the rebuilt cycles, then rescan at the same time. Distinct current hit
    # edge keys do not prove independence: an endpoint split can replace the
    # edge another tied split must re-derive against. Keep one deterministic
    # referee-order split site per iteration across every accepted site.
    arb_sep = separate_xyz(vector=input_position())
    arb_ev = separate_xyz(
        vector=input_named_attribute(name="sev", data_type="FLOAT_VECTOR")
    )
    sc_f = input_named_attribute(name="sc", data_type="FLOAT")
    cross_accept = accept
    n_cross = attribute_statistic(
        geometry=s_st, selection=cross_accept, attribute=1.0,
        data_type="FLOAT", domain="POINT",
    ).sum
    cross_multi = compare(a=n_cross, b=1.5, operation="GREATER_THAN")
    cross_s_min = attribute_statistic(
        geometry=s_st, selection=cross_accept, attribute=sc_f,
        data_type="FLOAT", domain="POINT",
    ).min
    cross_s_row = boolean_math(
        boolean=cross_accept,
        boolean_001=compare(a=sc_f, b=cross_s_min, operation="LESS_EQUAL"),
        operation="AND",
    )
    cross_x_min = attribute_statistic(
        geometry=s_st, selection=cross_s_row, attribute=arb_ev.x,
        data_type="FLOAT", domain="POINT",
    ).min
    cross_x_row = boolean_math(
        boolean=cross_s_row,
        boolean_001=compare(a=arb_ev.x, b=cross_x_min, operation="LESS_EQUAL"),
        operation="AND",
    )
    cross_y_min = attribute_statistic(
        geometry=s_st, selection=cross_x_row, attribute=arb_ev.y,
        data_type="FLOAT", domain="POINT",
    ).min
    cross_y_row = boolean_math(
        boolean=cross_x_row,
        boolean_001=compare(a=arb_ev.y, b=cross_y_min, operation="LESS_EQUAL"),
        operation="AND",
    )
    cross_r_min = attribute_statistic(
        geometry=s_st, selection=cross_y_row, attribute=arg_r,
        data_type="FLOAT", domain="POINT",
    ).min
    cross_lead = boolean_math(
        boolean=cross_y_row,
        boolean_001=compare(a=arg_r, b=cross_r_min, operation="LESS_EQUAL"),
        operation="AND",
    )
    drop_cross = boolean_math(
        boolean=boolean_math(
            boolean=cross_accept, boolean_001=cross_multi, operation="AND"
        ),
        boolean_001=boolean_math(boolean=cross_lead, operation="NOT"),
        operation="AND",
    )
    accept_serial = boolean_math(
        boolean=accept,
        boolean_001=boolean_math(boolean=drop_cross, operation="NOT"),
        operation="AND",
    )
    # D1 — same-edge co-timed split arbitration (finding F1, adversarial
    # review 2026-08-23; REVIEW-DECISIONS.md). The oracle applies same-t
    # events SEQUENTIALLY (evs[0] then rescan, sort key (s, kind, x, y,
    # uid)); the GN batch accepted BOTH same-edge splits at once and the
    # six-role patch cloud collided on the shared hit-edge endpoint slots
    # — keyed delivery kept one payload, the loser's r never died, and the
    # old strictly-future freshness gate blocked re-derivation -> per-ring
    # stall (fx8 pre-fix: code 7). Rule: among accepted sites keep only
    # the MIN EVENT-X site per hit-edge a-slot (site positions carry
    # (r_slot, a_slot); a_slot is the patch-target key the clouds collide
    # on, and min-x matches the oracle's (x, y) tie-break at equal s).
    # Suppressed splits re-derive next iteration at the same tnow via the
    # relaxed freshness gate, so no event is lost. Map-back keys
    # (a_slot, ev_x, ev_y) are unique for distinct split points; two
    # splits at one bit-exact point are the degenerate/cross-LAV class,
    # not this rule's (fx7 latch owns them).
    acc_arb = delete_geometry(
        geometry=s_st,
        selection=boolean_math(boolean=accept_serial, operation="NOT"),
        mode="ALL",
        domain="POINT",
    )
    # Named-attribute `sev` was baked on s_st pre-delete, not left as the raw
    # sw_nd field: that field is index-keyed and would re-evaluate against
    # acc_arb's compacted indices after the delete above.
    # Full-key cloud (a_slot, ev_x, ev_y); per-a-slot curves sorted by
    # event x; control point 0 of each curve = that hit edge's winner.
    arb_full = set_position(
        geometry=acc_arb,
        position=(arb_sep.y, arb_ev.x, arb_ev.y),
    )
    arb_full_p = separate_xyz(vector=input_position())
    arb_cur = points_to_curves(
        points=arb_full,
        curve_group_id=float_to_int(float=arb_full_p.x, rounding_mode="ROUND"),
        weight=arb_full_p.y,
    )
    arb_lead = delete_geometry(
        geometry=arb_cur,
        selection=compare(
            a=spline_parameter().index * 1.0, b=0.5, operation="GREATER_THAN"
        ),
        mode="ALL",
        domain="POINT",
    )
    # Points-typed twin of the leader curve (index-keyed copy):
    # sample_nearest below searches the keyed copy and accepts mesh/point
    # cloud only — feeding it the curve fires a permanent modifier ERROR
    # ("must contain a mesh or a point cloud") + INFO ("unsupported type:
    # Curve"). Twin keeps identical positions in identical control-point
    # order, so nearest-index results are unchanged. sample_index pins its
    # value field to arb_lead (the documented safe idiom), and the count
    # is arb_lead's own point count — no compaction path exists.
    arb_n_lead = attribute_domain_size(geometry=arb_lead, component="CURVE")
    arb_lead_pts = set_position(
        geometry=points(count=arb_n_lead),
        position=sample_index(
            geometry=arb_lead, value=input_position(), index=input_index(),
            data_type="FLOAT_VECTOR", domain="POINT",
        ),
    )
    # Keyed copy of the leaders (klc_key idiom): search on a_slot alone,
    # read the winning event position back from the full-key cloud.
    arb_lead_key = set_position(
        geometry=arb_lead_pts,
        position=(separate_xyz(vector=input_position()).x, 0.0, 0.0),
    )
    i_arb = sample_nearest(
        geometry=arb_lead_key,
        sample_position=(arb_sep.y, 0.0, 0.0),
        domain="POINT",
    )
    arb_win = separate_xyz(
        vector=sample_index(
            geometry=arb_lead, value=input_position(), index=i_arb,
            data_type="FLOAT_VECTOR", domain="POINT",
        )
    )
    # Exact equality is correct here: a leader reads its own float32
    # position back bit-exact; a suppressed sibling reads the winner's
    # (x, y), which differs for distinct split points on one edge.
    is_lead = boolean_math(
        boolean=compare(a=arb_ev.x, b=arb_win.y, operation="EQUAL"),
        boolean_001=compare(a=arb_ev.y, b=arb_win.z, operation="EQUAL"),
        operation="AND",
    )
    accept_fin = boolean_math(
        boolean=accept_serial, boolean_001=is_lead, operation="AND"
    )
    # TEMP extrusion-point code-6 diagnosis: on the corrupt-relation row,
    # export (r, a, b) through the site triplet and (lav_a, lav_b, pv_b)
    # through the winner triplet.  This changes debug readback only; event
    # acceptance and all production geometry remain untouched.
    diag_bad = boolean_math(
        boolean=boolean_math(boolean=pre_core, boolean_001=det_ok, operation="AND"),
        boolean_001=xlav_b,
        operation="AND",
    )
    site_a_s = attribute_statistic(
        geometry=s_st, selection=diag_bad, attribute=arg_r, data_type="FLOAT", domain="POINT"
    ).sum
    site_x_s = attribute_statistic(
        geometry=s_st, selection=diag_bad, attribute=arg_a, data_type="FLOAT", domain="POINT"
    ).sum
    site_y_s = attribute_statistic(
        geometry=s_st, selection=diag_bad, attribute=sw_b_f, data_type="FLOAT", domain="POINT"
    ).sum
    win_a_s = attribute_statistic(
        geometry=s_st, selection=diag_bad, attribute=sw_lav_a, data_type="FLOAT", domain="POINT"
    ).sum
    win_x_s = attribute_statistic(
        geometry=s_st, selection=diag_bad, attribute=sw_lav_b, data_type="FLOAT", domain="POINT"
    ).sum
    win_y_s = attribute_statistic(
        geometry=s_st, selection=diag_bad, attribute=sw_pv_b, data_type="FLOAT", domain="POINT"
    ).sum
    n_acc_dbg = attribute_statistic(
        geometry=s_st, selection=diag_bad, attribute=live_lav_a,
        data_type="FLOAT", domain="POINT"
    ).sum
    # Rung-3b code-6 discriminator: split the corrupt-relation count into
    # hit-edge LAV disagreement and broken b.pv->a reciprocity. These occupy
    # the existing gd14/gd15 debug-only slots; solver behavior is unchanged.
    xlav_ready = boolean_math(
        boolean=pre_core, boolean_001=det_ok, operation="AND"
    )
    ab_bad = boolean_math(
        boolean=ab_lav_bad, boolean_001=ab_lav_bad_neg, operation="OR"
    )
    pv_bad = boolean_math(
        boolean=pv_b_bad, boolean_001=pv_b_bad_neg, operation="OR"
    )
    cloud_n_s = attribute_statistic(
        geometry=s_st,
        selection=boolean_math(boolean=xlav_ready, boolean_001=ab_bad, operation="AND"),
        attribute=1.0,
        data_type="FLOAT",
        domain="POINT",
    ).sum
    cloud_x_s = attribute_statistic(
        geometry=s_st,
        selection=boolean_math(boolean=xlav_ready, boolean_001=pv_bad, operation="AND"),
        attribute=1.0,
        data_type="FLOAT",
        domain="POINT",
    ).sum
    n_acc = attribute_statistic(
        geometry=s_st, selection=accept_fin, attribute=1.0, data_type="FLOAT", domain="POINT"
    ).sum
    any_site = compare(a=n_acc, b=0.5, operation="GREATER_THAN")
    n_acc_i = float_to_int(float=n_acc, rounding_mode="ROUND")
    sites_acc = delete_geometry(
        geometry=s_st,
        selection=boolean_math(boolean=accept_fin, operation="NOT"),
        mode="ALL",
        domain="POINT",
    )
    # Rank-ordered accepted sites; positions carry (r_slot, a_slot).
    srk = points_to_curves(points=sites_acc, curve_group_id=0, weight=z_idx)
    # Points-typed twin of srk (index-keyed copy): the keyed delivery
    # clouds (srk_keyA/srk_keyB) feed sample_nearest, which accepts
    # mesh/point cloud only — the curve input fired the permanent
    # modifier ERROR/INFO warning pair. Twin keeps the same control-point
    # positions in the same order (count = accepted sites, by
    # construction), so nearest-index results are unchanged. sample_index
    # pins its value field to srk (the documented safe idiom).
    srk_pts = set_position(
        geometry=points(count=n_acc_i),
        position=sample_index(
            geometry=srk, value=input_position(), index=input_index(),
            data_type="FLOAT_VECTOR", domain="POINT",
        ),
    )
    return (
        srk, srk_pts, N_f, any_site, cap_ok, n_acc, n_acc_i, n_acc_pre,
        pre_core, det_bad, det_ok, xlav_b, amb5_s_row, dbg_b, dbg_c,
        n_acc_dbg, site_a_s, site_x_s, site_y_s, win_a_s, win_x_s,
        win_y_s, cloud_n_s, cloud_x_s,
    )


@node_tree(id="opus.gnslice.kill.v1", target="geometry")
def skel_kill(
    front: Geometry, srk: Geometry, n_acc_i: Integer,
    z_idx: Float, tnow: Float, any_site: Boolean,
) -> tuple[Boolean, Boolean, Float]:
    """Killed-slot detection: r (always) + at-u/at-w endpoint per site.

    Whole-chain move (revision contract S2, "kill" stage): the 3-row
    killed cloud, its `_sp_scan` instance, role gating, and the keyed
    nearest lookup relocate TOGETHER. `dying_sp` is a per-front-row
    Boolean field; `sp_time` (ksep2.y) is bound in-def because `.y`
    access does not resolve on def-call returns (Grove gap, filed
    2026-08-26). In-span-only: ksw_* unpack, k_role*, k_slot, k_valid,
    klc*, iK, kpos, ksep.
    """
    klc = points(count=n_acc_i * 3)
    k_g = math(value=math(value=z_idx, value_001=3.0, operation="DIVIDE"), operation="FLOOR")
    k_role = math(value=z_idx, value_001=3.0, operation="MODULO")
    site_pos_k = sample_index(
        geometry=srk, value=input_position(),
        index=float_to_int(float=k_g, rounding_mode="ROUND"),
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    ksep = separate_xyz(vector=site_pos_k)
    # Re-cut: kill consumes only the resolve columns b_f/cls/s_raw.
    (
        ksw_s_raw, dd_k_lam, ksw_cls, dd_k_nd, ksw_b_f,
        dd_k_pv_a_f, dd_k_pv_r_f, dd_k_nx_r_f, dd_k_nr_r, dd_k_ed_r,
        dd_k_ed_a, dd_k_ed_b, dd_k_ed_pa, dd_k_lav_r, dd_k_lav_a,
        dd_k_pos_a_s, dd_k_pos_b_s,
        dd_k_A_nr, dd_k_A_ed, dd_k_A_nx, dd_k_A_vl, dd_k_A_w,
        dd_k_B_pv, dd_k_B_vl, dd_k_B_w, dd_k_detA, dd_k_detB,
    ) = sp_resolve(geo=front, tnow=tnow, rsl=ksep.x, asl=ksep.y)
    k_role0 = compare(a=k_role, b=0.5, operation="LESS_EQUAL")
    k_role1 = boolean_math(
        boolean=boolean_math(boolean=k_role0, operation="NOT"),
        boolean_001=compare(a=k_role, b=1.5, operation="LESS_EQUAL"),
        operation="AND",
    )
    k_slot = switch(
        switch=k_role0, false=switch(switch=k_role1, false=ksw_b_f, true=ksep.y, input_type="FLOAT"),
        true=ksep.x, input_type="FLOAT",
    )
    k_cls0 = compare(a=ksw_cls, b=0.5, operation="LESS_EQUAL")
    k_cls2 = compare(a=ksw_cls, b=1.5, operation="GREATER_EQUAL")
    k_valid = switch(
        switch=k_role0, false=switch(switch=k_role1, false=k_cls2, true=k_cls0, input_type="BOOLEAN"),
        true=True, input_type="BOOLEAN",
    )
    klc_del = delete_geometry(
        geometry=set_position(geometry=klc, position=(k_slot, ksw_s_raw, k_role)),
        selection=boolean_math(boolean=k_valid, operation="NOT"),
        mode="ALL",
        domain="POINT",
    )
    # Keyed copy (see ptc_key note): search on the slot alone, read the
    # death time by index from the unkeyed cloud.
    klc_key = set_position(
        geometry=klc_del,
        position=(separate_xyz(vector=input_position()).x, 0.0, 0.0),
    )
    iK = sample_nearest(geometry=klc_key, sample_position=(z_idx, 0.0, 0.0), domain="POINT")
    kpos = sample_index(
        geometry=klc_del, value=input_position(), index=iK, data_type="FLOAT_VECTOR", domain="POINT"
    )
    ksep2 = separate_xyz(vector=kpos)
    dying_sp = boolean_math(
        boolean=any_site,
        boolean_001=compare(
            a=math(
                value=math(value=ksep2.x, value_001=z_idx, operation="SUBTRACT"),
                operation="ABSOLUTE",
            ),
            b=0.25,
            operation="LESS_THAN",
        ),
        operation="AND",
    )
    dying_r = boolean_math(
        boolean=dying_sp,
        boolean_001=compare(a=ksep2.z, b=0.5, operation="LESS_THAN"),
        operation="AND",
    )
    sp_time = ksep2.y
    return (dying_sp, dying_r, sp_time)


@node_tree(id="opus.gnslice.patch.v1", target="geometry")
def skel_patch(
    front: Geometry, srk: Geometry, n_acc_i: Integer,
    z_idx: Float, tnow: Float, any_site: Boolean,
    n_f: Float, bc: Float,
    f_dy: Geometry, f_sdy: Geometry,
    dy_f: Float, sdy_hd_f: Float,
) -> tuple[Boolean, Boolean, Float, Float]:
    """Six-role survivor-rewrite patch cloud (oracle _do_split surgery).

    r0 (u.nx), r1 (w.pv), r2 (pv_u.nx), r3 (nx_r.pv), r4 (pv_r.nx),
    r5 (nx_b.pv); position = (target, new_nx, new_pv); -1 marks "not this
    branch". Whole-chain move (revision contract S2, "patch" stage): the
    6-row cloud, its `_sp_scan` instance, dead-run retargets, role/class
    gating, and the keyed-copy delivery relocate TOGETHER. `p_nx_ok`/
    `p_pv_ok` are per-front-row Boolean fields; the payload components are
    bound in-def (`.y`/`.z` do not resolve on def-call returns — Grove
    gap, filed 2026-08-26). In-span-only: psw_* unpack, p_tgt/p_vnx/p_vpv,
    ptc*, iP, ppos, psep2, p_hit, B_slot_p.
    """
    ptc = points(count=n_acc_i * 6)
    p_g = math(value=math(value=z_idx, value_001=6.0, operation="DIVIDE"), operation="FLOOR")
    p_role = math(value=z_idx, value_001=6.0, operation="MODULO")
    site_pos_p = sample_index(
        geometry=srk, value=input_position(),
        index=float_to_int(float=p_g, rounding_mode="ROUND"),
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    psep = separate_xyz(vector=site_pos_p)
    # Re-cut: patch consumes pv_a_f/pv_r_f/cls/b_f/nx_r_f only.
    (
        dd_p_s_raw, dd_p_lam, psw_cls, dd_p_nd, psw_b_f,
        psw_pv_a_f, psw_pv_r_f, psw_nx_r_f, dd_p_nr_r, dd_p_ed_r,
        dd_p_ed_a, dd_p_ed_b, dd_p_ed_pa, dd_p_lav_r, dd_p_lav_a,
        dd_p_pos_a_s, dd_p_pos_b_s,
        dd_p_A_nr, dd_p_A_ed, dd_p_A_nx, dd_p_A_vl, dd_p_A_w,
        dd_p_B_pv, dd_p_B_vl, dd_p_B_w, dd_p_detA, dd_p_detB,
    ) = sp_resolve(geo=front, tnow=tnow, rsl=psep.x, asl=psep.y)
    B_slot_p = math(
        value=math(value=n_f, value_001=bc, operation="ADD"), value_001=p_g, operation="ADD"
    )
    # Patch-target retargets through dead runs (fx4/fx5): a co-timed edge
    # batch can kill the slot a patch targets — the write must land on
    # the run's reborn head. All three stages must name the same holder;
    # walking r0 past the head breaks q.nx/B.pv reciprocity while leaving
    # both pointer values individually in bounds.
    p0_i = float_to_int(float=psep.y, rounding_mode="ROUND")
    p0_hd = sample_index(geometry=f_sdy, value=sdy_hd_f, index=p0_i, data_type="FLOAT", domain="POINT")
    p0_tgt = switch(
        switch=compare(
            a=sample_index(geometry=f_dy, value=dy_f, index=p0_i, data_type="FLOAT", domain="POINT"),
            b=0.5, operation="GREATER_THAN",
        ),
        false=psep.y,
        true=p0_hd,
        input_type="FLOAT",
    )
    p2_i = float_to_int(float=psw_pv_a_f, rounding_mode="ROUND")
    p2_tgt = switch(
        switch=compare(
            a=sample_index(geometry=f_dy, value=dy_f, index=p2_i, data_type="FLOAT", domain="POINT"),
            b=0.5, operation="GREATER_THAN",
        ),
        false=psw_pv_a_f,
        true=sample_index(geometry=f_sdy, value=sdy_hd_f, index=p2_i, data_type="FLOAT", domain="POINT"),
        input_type="FLOAT",
    )
    p4_i = float_to_int(float=psw_pv_r_f, rounding_mode="ROUND")
    p4_tgt = switch(
        switch=compare(
            a=sample_index(geometry=f_dy, value=dy_f, index=p4_i, data_type="FLOAT", domain="POINT"),
            b=0.5, operation="GREATER_THAN",
        ),
        false=psw_pv_r_f,
        true=sample_index(geometry=f_sdy, value=sdy_hd_f, index=p4_i, data_type="FLOAT", domain="POINT"),
        input_type="FLOAT",
    )
    # r1 writes the pointer reciprocal to newborn A.nx. The split is applied
    # to the accepted site's original hit-edge endpoint; non-meeting edge
    # rows are deferred before the edge batch instead of retargeting surgery.
    p1_tgt = psw_b_f
    # At-w mirror: w dies, but w.nx survives and must point back to newborn
    # A. Address that successor directly; writing w itself only patches a
    # dead slot and leaves the live edge non-reciprocal.
    nx_fa = input_named_attribute(name="nx", data_type="FLOAT")
    p5_tgt = sample_index(
        geometry=front,
        value=nx_fa,
        index=float_to_int(float=psw_b_f, rounding_mode="ROUND"),
        data_type="FLOAT",
        domain="POINT",
    )
    p_role0 = compare(a=p_role, b=0.5, operation="LESS_EQUAL")
    p_role1 = boolean_math(
        boolean=boolean_math(boolean=p_role0, operation="NOT"),
        boolean_001=compare(a=p_role, b=1.5, operation="LESS_EQUAL"),
        operation="AND",
    )
    p_role2 = boolean_math(
        boolean=boolean_math(boolean=p_role1, operation="NOT"),
        boolean_001=compare(a=p_role, b=2.5, operation="LESS_EQUAL"),
        operation="AND",
    )
    p_role3 = boolean_math(
        boolean=boolean_math(boolean=p_role2, operation="NOT"),
        boolean_001=compare(a=p_role, b=3.5, operation="LESS_EQUAL"),
        operation="AND",
    )
    p_role4 = boolean_math(
        boolean=boolean_math(boolean=p_role3, operation="NOT"),
        boolean_001=compare(a=p_role, b=4.5, operation="LESS_EQUAL"),
        operation="AND",
    )
    p_cls0 = compare(a=psw_cls, b=0.5, operation="LESS_EQUAL")
    p_cls1 = boolean_math(
        boolean=boolean_math(boolean=p_cls0, operation="NOT"),
        boolean_001=compare(a=psw_cls, b=1.5, operation="LESS_EQUAL"),
        operation="AND",
    )
    p_cls2 = compare(a=psw_cls, b=1.5, operation="GREATER_EQUAL")
    p_tgt = switch(
        switch=p_role0, false=switch(
            switch=p_role1, false=switch(
                switch=p_role2, false=switch(
                    switch=p_role3, false=switch(
                        switch=p_role4, false=p5_tgt, true=p4_tgt, input_type="FLOAT"
                    ),
                    true=psw_nx_r_f, input_type="FLOAT",
                ),
                true=p2_tgt, input_type="FLOAT",
            ),
            true=p1_tgt, input_type="FLOAT",
        ),
        true=p0_tgt, input_type="FLOAT",
    )
    p_vnx = switch(
        switch=p_role0, false=switch(
            switch=p_role1, false=switch(
                switch=p_role2, false=switch(
                    switch=p_role3, false=switch(
                        switch=p_role4, false=-1.0, input_type="FLOAT",
                        true=-1.0,
                        input_type="FLOAT",
                    ),
                    true=-1.0, input_type="FLOAT",
                ),
                true=switch(switch=p_cls0, false=-1.0, true=B_slot_p, input_type="FLOAT"), input_type="FLOAT",
            ),
            true=-1.0, input_type="FLOAT",
        ),
        true=switch(switch=p_cls2, false=switch(switch=p_cls1, false=-1.0, true=B_slot_p, input_type="FLOAT"), true=B_slot_p, input_type="FLOAT"),
        input_type="FLOAT",
    )
    p_vpv = switch(
        switch=p_role0, false=switch(
            switch=p_role1, false=switch(
                switch=p_role2, false=switch(
                    switch=p_role3, false=switch(
                        switch=p_role4, false=switch(
                            switch=p_cls2, false=-1.0, true=psep.x, input_type="FLOAT"
                        ),
                        true=-1.0, input_type="FLOAT",
                    ),
                    # nx_r.pv := B on every class. At-w newborn B is p1,
                    # whose out-edge is r.ne; A is p2 on w's successor.
                    true=B_slot_p,
                    input_type="FLOAT",
                ),
                true=-1.0, input_type="FLOAT",
            ),
            # w.pv := A on interior AND at-u (oracle: w.pe = e1 / e.b
            # reparenting); at-w the endpoint dies instead.
            true=switch(switch=p_cls2, false=psep.x, true=-1.0, input_type="FLOAT"),
            input_type="FLOAT",
        ),
        true=-1.0, input_type="FLOAT",
    )
    ptc_del = delete_geometry(
        geometry=set_position(geometry=ptc, position=(p_tgt, p_vnx, p_vpv)),
        selection=boolean_math(
            boolean=compare(a=p_vnx, b=-0.5, operation="LESS_THAN"),
            boolean_001=compare(a=p_vpv, b=-0.5, operation="LESS_THAN"),
            operation="AND",
        ),
        mode="ALL",
        domain="POINT",
    )
    # Payload fields ride in the point position until the keyed gathers.
    pdel_sep = separate_xyz(vector=input_position())
    # Keyed delivery is field-specific. Two complementary oracle roles may
    # target the same survivor in one split (one writes nx, one writes pv), so
    # a single nearest row cannot represent the patch. The diagnostic F01
    # second split measured exactly that shape: two rows, one writer per field.
    ptc_nx = delete_geometry(
        geometry=ptc_del,
        selection=boolean_math(
            boolean=compare(a=pdel_sep.y, b=-0.5, operation="GREATER_THAN"),
            operation="NOT",
        ),
        mode="ALL", domain="POINT",
    )
    ptc_nx_key = set_position(
        geometry=ptc_nx,
        position=(separate_xyz(vector=input_position()).x, 0.0, 0.0),
    )
    iP_nx = sample_nearest(
        geometry=ptc_nx_key, sample_position=(z_idx, 0.0, 0.0), domain="POINT"
    )
    ppos_nx = sample_index(
        geometry=ptc_nx, value=input_position(), index=iP_nx,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    psep_nx = separate_xyz(vector=ppos_nx)
    p_nx_hit = boolean_math(
        boolean=any_site,
        boolean_001=compare(
            a=0.25,
            b=math(
                value=math(value=psep_nx.x, value_001=z_idx, operation="SUBTRACT"),
                operation="ABSOLUTE",
            ),
            operation="GREATER_THAN",
        ),
        operation="AND",
    )
    p_nx_ok = boolean_math(
        boolean=p_nx_hit,
        boolean_001=compare(a=psep_nx.y, b=-0.5, operation="GREATER_THAN"),
        operation="AND",
    )
    p_nx_val = psep_nx.y

    ptc_pv = delete_geometry(
        geometry=ptc_del,
        selection=boolean_math(
            boolean=compare(a=pdel_sep.z, b=-0.5, operation="GREATER_THAN"),
            operation="NOT",
        ),
        mode="ALL", domain="POINT",
    )
    ptc_pv_key = set_position(
        geometry=ptc_pv,
        position=(separate_xyz(vector=input_position()).x, 0.0, 0.0),
    )
    iP_pv = sample_nearest(
        geometry=ptc_pv_key, sample_position=(z_idx, 0.0, 0.0), domain="POINT"
    )
    ppos_pv = sample_index(
        geometry=ptc_pv, value=input_position(), index=iP_pv,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    psep_pv = separate_xyz(vector=ppos_pv)
    p_pv_hit = boolean_math(
        boolean=any_site,
        boolean_001=compare(
            a=0.25,
            b=math(
                value=math(value=psep_pv.x, value_001=z_idx, operation="SUBTRACT"),
                operation="ABSOLUTE",
            ),
            operation="GREATER_THAN",
        ),
        operation="AND",
    )
    p_pv_ok = boolean_math(
        boolean=p_pv_hit,
        boolean_001=compare(a=psep_pv.z, b=-0.5, operation="GREATER_THAN"),
        operation="AND",
    )
    p_pv_val = psep_pv.z
    return (p_nx_ok, p_pv_ok, p_nx_val, p_pv_val)


@node_tree(id="opus.gnslice.newborn_keys.v1", target="geometry")
def skel_newborn_keys(
    srk_pts: Geometry, srk: Geometry, z_idx: Float, any_site: Boolean,
    n_f: Float, bc: Float,
) -> tuple[Boolean, Boolean, Integer, Integer, Float, Float, Float, Float]:
    """Pool-side newborn key lookups (structural step 6).

    A-side keyed by r_slot, B-side by B_slot (= N + bc + rank, stamped as the
    keyed copy's own position). Verbatim span from the solve zone; the A/B
    position components are returned as scalars because group-output sockets
    do not resolve attribute access at the call site.
    In-span-only names: srk_sep, srk_keyA, aposA, srk_Bx, srk_keyB, aposB,
    bslot_near.
    """
    srk_sep = separate_xyz(vector=input_position())
    srk_keyA = set_position(geometry=srk_pts, position=(srk_sep.x, 0.0, 0.0))
    iA = sample_nearest(geometry=srk_keyA, sample_position=(z_idx, 0.0, 0.0), domain="POINT")
    aposA = sample_index(
        geometry=srk, value=input_position(), index=iA, data_type="FLOAT_VECTOR", domain="POINT"
    )
    asepA = separate_xyz(vector=aposA)
    is_A = boolean_math(
        boolean=any_site,
        boolean_001=compare(
            a=math(
                value=math(value=asepA.x, value_001=z_idx, operation="SUBTRACT"),
                operation="ABSOLUTE",
            ),
            b=0.25,
            operation="LESS_THAN",
        ),
        operation="AND",
    )
    srk_Bx = math(
        value=math(value=n_f, value_001=bc, operation="ADD"), value_001=z_idx, operation="ADD"
    )
    srk_keyB = set_position(geometry=srk_pts, position=(srk_Bx, 0.0, 0.0))
    iB = sample_nearest(geometry=srk_keyB, sample_position=(z_idx, 0.0, 0.0), domain="POINT")
    aposB = sample_index(
        geometry=srk, value=input_position(), index=iB, data_type="FLOAT_VECTOR", domain="POINT"
    )
    asepB = separate_xyz(vector=aposB)
    # B-slot match by index math: the nearest keyed point's B slot is
    # N + bc + iB (iB is its rank); is_B when that equals this slot.
    bslot_near = math(
        value=math(value=n_f, value_001=bc, operation="ADD"),
        value_001=iB * 1.0,
        operation="ADD",
    )
    is_B = boolean_math(
        boolean=any_site,
        boolean_001=compare(
            a=math(
                value=math(value=bslot_near, value_001=z_idx, operation="SUBTRACT"),
                operation="ABSOLUTE",
            ),
            b=0.25,
            operation="LESS_THAN",
        ),
        operation="AND",
    )
    a_a_x = asepA.x
    a_a_y = asepA.y
    a_b_x = asepB.x
    a_b_y = asepB.y
    return (is_A, is_B, iA, iB, a_a_x, a_a_y, a_b_x, a_b_y)


@node_tree(id="opus.gnslice.site_arcs.v1", target="geometry")
def skel_site_arcs(
    front: Geometry, srk: Geometry, n_acc_i: Integer, z_idx: Float,
    tnow: Float, ap_f: Vector, at_f: Float,
) -> tuple[Geometry, Geometry]:
    """Site-side death arcs (structural step 7): the hit-at-u / hit-at-w
    endpoint's travel arc into the split node (oracle _arc(u|w, nd)); the
    reflex r's own arc rides the pool-side dying mask. Parents are the dying
    endpoint's pe/ne wall ids (ed_pa/ed_a for u, ed_a/ed_b for w).

    The D2 twin (one shared resolve for both sides) landed after the _sp_scan
    re-cut's bit-exactness harness proved the triple inert (contract S6 step 3).
    In-span-only names: uarc_c, usite, usep, the one sp_resolve row,
    uw_/ww_ column aliases, u_ap_*, u1..u6, warc_c, w_ap_*, w1..w6.
    """
    uarc_c = points(count=n_acc_i)
    usite = sample_index(
        geometry=srk, value=input_position(),
        index=float_to_int(float=z_idx, rounding_mode="ROUND"),
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    usep = separate_xyz(vector=usite)
    # Re-cut + D2 (contract S2/S4): the u- and w-side scan sites were a
    # BIT-IDENTICAL duplicate pair -- same srk sample, same z_idx index.
    # ONE sp_resolve row now feeds both arc sides; each side keeps its
    # consumed-column spellings via direct bindings and two aliases below.
    (
        dd_u_s_raw, dd_u_lam, uw_cls, uw_nd, ww_b_f,
        dd_u_pv_a_f, dd_u_pv_r_f, dd_u_nx_r_f, dd_u_nr_r, dd_u_ed_r,
        uw_ed_a, ww_ed_b, uw_ed_pa, dd_u_lav_r, dd_u_lav_a,
        dd_u_pos_a_s, dd_u_pos_b_s,
        dd_u_A_nr, dd_u_A_ed, dd_u_A_nx, dd_u_A_vl, dd_u_A_w,
        dd_u_B_pv, dd_u_B_vl, dd_u_B_w, dd_u_detA, dd_u_detB,
    ) = sp_resolve(geo=front, tnow=tnow, rsl=usep.x, asl=usep.y)
    # w-side column spellings for the SAME resolved values.
    ww_cls = uw_cls
    ww_nd = uw_nd
    ww_ed_a = uw_ed_a
    # The travel arc starts at the dying endpoint's ANCHORED leg position
    # (ap, z = its at), not its position at the split time — the oracle's
    # arc runs leg-start -> split node (fx5: (0,0,0) -> (1,1,1), never a
    # zero-length (1,1) -> (1,1)).
    u_ap_i = float_to_int(float=usep.y, rounding_mode="ROUND")
    u_ap_v = sample_index(
        geometry=front, value=ap_f, index=u_ap_i, data_type="FLOAT_VECTOR", domain="POINT"
    )
    u_at_v = sample_index(
        geometry=front, value=at_f, index=u_ap_i, data_type="FLOAT", domain="POINT"
    )
    u_ap_z = vector_math(
        vector=u_ap_v, vector_001=combine_xyz(x=0.0, y=0.0, z=u_at_v), operation="ADD"
    )
    u1 = store_named_attribute(
        geometry=uarc_c, name="aa", value=u_ap_z, data_type="FLOAT_VECTOR", domain="POINT"
    )
    u2 = store_named_attribute(
        geometry=u1, name="bb", value=uw_nd, data_type="FLOAT_VECTOR", domain="POINT"
    )
    u3 = store_named_attribute(
        geometry=u2, name="al", value=uw_ed_pa, data_type="FLOAT", domain="POINT"
    )
    u4 = store_named_attribute(
        geometry=u3, name="ar", value=uw_ed_a, data_type="FLOAT", domain="POINT"
    )
    u5 = store_named_attribute(
        geometry=u4, name="sq", value=input_index() * 2.0, data_type="FLOAT", domain="POINT"
    )
    u6 = store_named_attribute(
        geometry=u5, name="cp", value=0.0, data_type="FLOAT", domain="POINT"
    )
    uarc = delete_geometry(
        geometry=u6,
        selection=boolean_math(
            boolean=compare(a=uw_cls, b=0.5, operation="LESS_EQUAL"), operation="NOT"
        ),
        mode="ALL", domain="POINT",
    )
    warc_c = points(count=n_acc_i)
    w_ap_i = float_to_int(float=ww_b_f, rounding_mode="ROUND")
    w_ap_v = sample_index(
        geometry=front, value=ap_f, index=w_ap_i, data_type="FLOAT_VECTOR", domain="POINT"
    )
    w_at_v = sample_index(
        geometry=front, value=at_f, index=w_ap_i, data_type="FLOAT", domain="POINT"
    )
    w_ap_z = vector_math(
        vector=w_ap_v, vector_001=combine_xyz(x=0.0, y=0.0, z=w_at_v), operation="ADD"
    )
    w1 = store_named_attribute(
        geometry=warc_c, name="aa", value=w_ap_z, data_type="FLOAT_VECTOR", domain="POINT"
    )
    w2 = store_named_attribute(
        geometry=w1, name="bb", value=ww_nd, data_type="FLOAT_VECTOR", domain="POINT"
    )
    w3 = store_named_attribute(
        geometry=w2, name="al", value=ww_ed_a, data_type="FLOAT", domain="POINT"
    )
    w4 = store_named_attribute(
        geometry=w3, name="ar", value=ww_ed_b, data_type="FLOAT", domain="POINT"
    )
    w5 = store_named_attribute(
        geometry=w4, name="sq", value=input_index() * 2.0, data_type="FLOAT", domain="POINT"
    )
    w6 = store_named_attribute(
        geometry=w5, name="cp", value=0.0, data_type="FLOAT", domain="POINT"
    )
    warc = delete_geometry(
        geometry=w6,
        selection=boolean_math(
            boolean=compare(a=ww_cls, b=1.5, operation="GREATER_EQUAL"), operation="NOT"
        ),
        mode="ALL", domain="POINT",
    )
    return (uarc, warc)


@node_tree(id="opus.gnslice.ev_arcs.v1", target="geometry")
def skel_ev_arcs(
    f_sm: Geometry, t_min: Float, sp_time: Float, dying_sp: Boolean,
    ap_f: Vector, at_f: Float, vl_f: Vector, ed_f: Float, ce_b2: Boolean,
    pv_f: Float, nx_o: Float, z_i: Integer, pv_i: Integer, z_it: Integer,
) -> tuple[Geometry, Vector, Float, Vector, Float, Vector, Boolean]:
    """S6 arc emission (structural step 8): the per-dying-vertex event arc
    chain plus the five field results the zone consumes downstream
    (S5 ap_head/at_new switches, S7 caps/ridges stores).
    sq_ev keys delivery by ITERATION (2*z): the zone-scope original was bare
    `index` = the repeat zone's Iteration socket (Grove lower.py
    _REPEAT_SPECIALS), NOT an element index — so the def receives it as the
    z_it VALUE param. input_index() or the z_i field here read the e-chain's
    element index instead (ITER19/ITER20 gate-RED, both bit-identical
    wrong: z_idx is itself a dangling Index-node field).
    In-span-only names: p_death, p_death_sp, pt_f, pt_i, ap_pt, at_pt, vl_pt,
    B_pt, ap_pin, D_pt, det_pt, num_pt, det_pt_ok, sig_pt, t_own, nd_ev,
    p_death2, death_t, sep_ap, sep_pd, sq_ev, e1..e6.
    """
    p_death = vector_math(
        vector=ap_f,
        vector_001=vector_math(
            vector=vl_f, scale=t_min - at_f, operation="SCALE"
        ),
        operation="ADD",
    )
    # Split deaths land at their OWN site time s, not global t_min: the
    # arc must end exactly on the newborn anchor (nd) so face cycles
    # close on one node.
    p_death_sp = vector_math(
        vector=ap_f,
        vector_001=vector_math(
            vector=vl_f, scale=sp_time - at_f, operation="SCALE"
        ),
        operation="ADD",
    )
    # Task #6 canonical edge-event closure (sw18/sw20/sw03): the dying
    # vertex's SELF-integrated position ap+vl*(t_min-at) amplifies
    # float32 time/velocity quantization by the bisector speed (measured
    # speed 540 at 1+n.n=6.8e-6 -> 1.34e-5..1.77e-4 offsets, past weld
    # 1e-5 and tol: twin vertices sw18/sw20, micro-face sw03). Close
    # instead on the pair-collision point of the two dying endpoints:
    # Cramer on [vl, -vl_pt], whose det cross(vl, vl_pt) GROWS with
    # speed, so the estimate stays ~1e-7 on the same inputs (the
    # _sp_scan nd stamp relies on the same conditioning at split sites).
    # Partner = nx when this row's own outgoing edge is the batch event,
    # else pv (this row dies via ce at its prv).
    pt_f = switch(switch=ce_b2, false=pv_f, true=nx_o, input_type="FLOAT")
    pt_i = float_to_int(float=pt_f, rounding_mode="ROUND")
    ap_pt = sample_index(
        geometry=f_sm, value=ap_f, index=pt_i, data_type="FLOAT_VECTOR", domain="POINT"
    )
    at_pt = sample_index(
        geometry=f_sm, value=at_f, index=pt_i, data_type="FLOAT", domain="POINT"
    )
    vl_pt = sample_index(
        geometry=f_sm, value=vl_f, index=pt_i, data_type="FLOAT_VECTOR", domain="POINT"
    )
    # Partner trajectory re-anchored to THIS row's at:
    # ap + vl*sig = B_pt + vl_pt*sig, B_pt = ap_pt + vl_pt*(at - at_pt)
    B_pt = vector_math(
        vector=ap_pt,
        vector_001=vector_math(vector=vl_pt, scale=at_f - at_pt, operation="SCALE"),
        operation="ADD",
    )
    # Task #7 root-cause pin (measured sw01, 2026-08-24): the rebuild
    # chain stores `ap` BEFORE `at`, so any later read of the UNPINNED
    # ap_f inside at_new's value field (evaluated at the at-store, whose
    # chain input already carries the overwritten ap = nd_c) solves the
    # Cramer against the post-collision position: D_pt degenerates
    # parallel to vl_pt (num ~ 0, sig ~ 0) and the head's anchor time
    # collapses to its stale at (heads born at t=2.27095/2.56127 stored
    # at = 0.0/0.31738). Self-sample onto f_sm pins this row's own ap to
    # the old generation in every consumer context — the same idiom as
    # the nx_o pin at the top of the zone. In the arc-emission chain the
    # pin returns the identical value, so death stamps are unchanged.
    ap_pin = sample_index(
        geometry=f_sm, value=ap_f, index=z_i, data_type="FLOAT_VECTOR", domain="POINT"
    )
    D_pt = vector_math(vector=B_pt, vector_001=ap_pin, operation="SUBTRACT")
    det_pt = separate_xyz(
        vector=vector_math(vector=vl_f, vector_001=vl_pt, operation="CROSS_PRODUCT")
    ).z
    num_pt = separate_xyz(
        vector=vector_math(vector=D_pt, vector_001=vl_pt, operation="CROSS_PRODUCT")
    ).z
    det_pt_ok = compare(
        a=math(value=det_pt, operation="ABSOLUTE"), b=1e-12, operation="GREATER_EQUAL"
    )
    sig_pt = math(value=num_pt, value_001=det_pt, operation="DIVIDE")
    # Task #7 (F1, re-review 2026-08-24): the pair stamp must carry its
    # OWN collision time, not the batch t_min. A band-admitted later
    # candidate (cand = t_min + delta) intersects at at+sig_pt; stamping
    # that XY with z=t_min emits a point off its trajectory by vl*delta
    # (measured fx9: speed 650, delta 1.54e-5 -> 1e-2 internal XY/z
    # inconsistency, 1.5e-5 z error vs oracle, caught by the comparator's
    # z-consistency gate). The fallback (guard-failed) path keeps
    # (p_death, t_min) — that pair is self-consistent by construction.
    t_own = math(value=at_f, value_001=sig_pt, operation="ADD")
    t_ev = switch(switch=det_pt_ok, false=t_min, true=t_own, input_type="FLOAT")
    nd_ev = vector_math(
        vector=ap_f,
        vector_001=vector_math(vector=vl_f, scale=sig_pt, operation="SCALE"),
        operation="ADD",
    )
    nd_c = switch(switch=det_pt_ok, false=p_death, true=nd_ev, input_type="VECTOR")
    p_death2 = switch(
        switch=dying_sp, false=nd_c, true=p_death_sp, input_type="VECTOR"
    )
    death_t = switch(switch=dying_sp, false=t_ev, true=sp_time, input_type="FLOAT")
    zero_dur = boolean_math(
        boolean=compare(a=death_t, b=at_f, operation="GREATER_THAN"), operation="NOT"
    )
    sep_ap = separate_xyz(vector=ap_f)
    sep_pd = separate_xyz(vector=p_death2)
    arc_a = combine_xyz(x=sep_ap.x, y=sep_ap.y, z=at_f)
    arc_b = combine_xyz(x=sep_pd.x, y=sep_pd.y, z=death_t)
    ed_prv = sample_index(
        geometry=f_sm, value=ed_f, index=pv_i, data_type="FLOAT", domain="POINT"
    )
    sq_ev = z_it * 2.0

    e1 = store_named_attribute(
        geometry=f_sm, name="aa", value=arc_a, data_type="FLOAT_VECTOR", domain="POINT"
    )
    e2 = store_named_attribute(
        geometry=e1, name="bb", value=arc_b, data_type="FLOAT_VECTOR", domain="POINT"
    )
    e3 = store_named_attribute(
        geometry=e2, name="al", value=ed_prv, data_type="FLOAT", domain="POINT"
    )
    e4 = store_named_attribute(
        geometry=e3, name="ar", value=ed_f, data_type="FLOAT", domain="POINT"
    )
    e5 = store_named_attribute(
        geometry=e4, name="sq", value=sq_ev, data_type="FLOAT", domain="POINT"
    )
    e6 = store_named_attribute(
        geometry=e5, name="cp", value=0.0, data_type="FLOAT", domain="POINT"
    )
    return (e6, arc_a, ed_prv, nd_c, t_ev, p_death, zero_dur)


@node_tree(id="opus.gnslice.caps.v1", target="geometry")
def skel_caps(
    f_sm: Geometry, nx_i: Integer, ap_f: Vector, at_f: Float, ed_f: Float,
    arc_a: Vector, ed_prv: Float, ring2_b: Boolean, done: Boolean,
    is_leader: Boolean, z_it: Integer,
) -> tuple[Geometry, Geometry, Float, Float, Boolean]:
    """S7 per-ring termination (structural step 9): the cap record chain and
    the one-ridge-per-2-ring chain, plus the td latch fields and not_done the
    zone consumes downstream (:2838 rebuild tail td_g, :2991 error gate).
    sq_term keys delivery by ITERATION (2*z+1): the zone-scope original was
    bare `index` = the repeat zone's Iteration socket (Grove lower.py
    _REPEAT_SPECIALS), NOT an element index — so the def receives it as the
    z_it VALUE param wired z_it=index at the call site. input_index() here
    would read the c/g chains' element index instead (step-8 ITER19 law).
    In-span-only names: ap_nxt, at_nxt, sep_apn, ridge_b, ed_nxt, not_td,
    cap_ok_z, cap_sel, ridge_pre, drop_cap, drop_ridge, c1..c6, g1..g6.
    """
    # --- S7 per-ring termination: caps + one ridge per 2-ring ----------
    ap_nxt = sample_index(
        geometry=f_sm, value=ap_f, index=nx_i, data_type="FLOAT_VECTOR", domain="POINT"
    )
    at_nxt = sample_index(
        geometry=f_sm, value=at_f, index=nx_i, data_type="FLOAT", domain="POINT"
    )
    sep_apn = separate_xyz(vector=ap_nxt)
    ridge_b = combine_xyz(x=sep_apn.x, y=sep_apn.y, z=at_nxt)
    # Rung 3a (fx7a): the ridge's LEFT parent must read the ring
    # PARTNER's edge, and the partner of a ring2 is nx — not pv. A
    # 2-ring formed by an edge-collapse chain has pv == nx, so the old
    # ed_prv read was equivalent there (whole unit corpus). A 2-ring
    # formed DIRECTLY by split rebirth keeps a stale pv (measured fx7a:
    # leader row pv=4, a dead/repurposed slot reading ed=0, while nx=6
    # holds the hit wall's ed=4) — the seam ridge stamped (0,0) where
    # the oracle stamps the covering walls (4,0). The endpoint
    # ridge_b already samples at nx_i; the parent now matches it.
    ed_nxt = sample_index(
        geometry=f_sm, value=ed_f, index=nx_i, data_type="FLOAT", domain="POINT"
    )
    sq_term = z_it * 2.0 + 1.0
    not_done = boolean_math(boolean=done, operation="NOT")
    # A 2-ring member emits its cap exactly once (td latch, stored in the
    # rebuild tail); the lower-bo member (oracle frm) emits the ridge.
    # Heights come from each slot's OWN stored birth anchors (ap/at on
    # f_sm) — never from global tnow.
    td_f = input_named_attribute(name="td", data_type="FLOAT")
    not_td = compare(a=td_f, b=0.5, operation="LESS_THAN")
    cap_ok_z = boolean_math(boolean=ring2_b, boolean_001=not_done, operation="AND")
    cap_sel = boolean_math(boolean=cap_ok_z, boolean_001=not_td, operation="AND")
    ridge_pre = boolean_math(boolean=cap_sel, boolean_001=is_leader, operation="AND")
    td_new_v = switch(switch=cap_sel, false=td_f, true=1.0, input_type="FLOAT")
    drop_cap = boolean_math(boolean=cap_sel, operation="NOT")
    drop_ridge = boolean_math(boolean=ridge_pre, operation="NOT")

    c1 = store_named_attribute(
        geometry=f_sm, name="aa", value=arc_a, data_type="FLOAT_VECTOR", domain="POINT"
    )
    c2 = store_named_attribute(
        geometry=c1, name="bb", value=arc_a, data_type="FLOAT_VECTOR", domain="POINT"
    )
    c3 = store_named_attribute(
        geometry=c2, name="al", value=ed_prv, data_type="FLOAT", domain="POINT"
    )
    c4 = store_named_attribute(
        geometry=c3, name="ar", value=ed_f, data_type="FLOAT", domain="POINT"
    )
    c5 = store_named_attribute(
        geometry=c4, name="sq", value=sq_term, data_type="FLOAT", domain="POINT"
    )
    c6 = store_named_attribute(
        geometry=c5, name="cp", value=1.0, data_type="FLOAT", domain="POINT"
    )
    caps = delete_geometry(
        geometry=c6, selection=drop_cap, mode="ALL", domain="POINT"
    )

    g1 = store_named_attribute(
        geometry=f_sm, name="aa", value=arc_a, data_type="FLOAT_VECTOR", domain="POINT"
    )
    g2 = store_named_attribute(
        geometry=g1, name="bb", value=ridge_b, data_type="FLOAT_VECTOR", domain="POINT"
    )
    g3 = store_named_attribute(
        geometry=g2, name="al", value=ed_nxt, data_type="FLOAT", domain="POINT"
    )
    g4 = store_named_attribute(
        geometry=g3, name="ar", value=ed_f, data_type="FLOAT", domain="POINT"
    )
    g5 = store_named_attribute(
        geometry=g4, name="sq", value=sq_term, data_type="FLOAT", domain="POINT"
    )
    g6 = store_named_attribute(
        geometry=g5, name="cp", value=2.0, data_type="FLOAT", domain="POINT"
    )
    ridge = delete_geometry(
        geometry=g6, selection=drop_ridge, mode="ALL", domain="POINT"
    )
    return (caps, ridge, td_new_v, td_f, not_done)


@node_tree(id="opus.gnslice.rebase.v1", target="geometry")
def skel_rebase(
    f_sm: Geometry, sm_f: Float, ce_b2: Boolean, not_cep: Boolean,
    nx_f: Float, nr_f: Vector, ed_f: Float, pv_i: Integer, hd_f: Float,
    w_f: Float, dying: Boolean, dying_sp: Boolean, alive: Boolean,
    nd_c: Vector, p_death: Vector, t_ev: Float, t_min: Float,
    ap_f: Vector, at_f: Float, vl_f: Vector,
) -> tuple[Boolean, Boolean, Vector, Vector, Float, Float, Vector, Float, Vector, Vector, Float, Float, Float]:
    """S5 survivor rebase (structural step 10): the immutable-rebuild prep —
    pinned sample_index reads at f_sm (sm/pv slots) plus the survivor and
    reborn-head value switches the fold consumes (lv/ap/at/vl/nr/ed/nx/w _new,
    is_head, not_dying_all, nr_sm/nr_prv for detH, pv_hd for pv_g).
    No zone specials in span — body byte-verbatim from the zone region.
    In-span-only names: sm_i, nx_sm, ed_sm, w_pv_h, w_sm, vel_new, survive,
    keep, ap_head.
    """
    sm_i = float_to_int(float=sm_f, rounding_mode="ROUND")
    is_head = boolean_math(boolean=ce_b2, boolean_001=not_cep, operation="AND")
    nx_sm = sample_index(
        geometry=f_sm, value=nx_f, index=sm_i, data_type="FLOAT", domain="POINT"
    )
    nr_sm = sample_index(
        geometry=f_sm, value=nr_f, index=sm_i, data_type="FLOAT_VECTOR", domain="POINT"
    )
    ed_sm = sample_index(
        geometry=f_sm, value=ed_f, index=sm_i, data_type="FLOAT", domain="POINT"
    )
    nr_prv = sample_index(
        geometry=f_sm, value=nr_f, index=pv_i, data_type="FLOAT_VECTOR", domain="POINT"
    )
    pv_hd = sample_index(
        geometry=f_sm, value=hd_f, index=pv_i, data_type="FLOAT", domain="POINT"
    )
    # rung 3a: the reborn head's in-edge is (pv -> head) with weight
    # w[pv]; its new out-edge is sm's OLD out-edge with weight w[sm],
    # which is also the slot's stored w (carrier convention).
    w_pv_h = sample_index(
        geometry=f_sm, value=w_f, index=pv_i, data_type="FLOAT", domain="POINT"
    )
    w_sm = sample_index(
        geometry=f_sm, value=w_f, index=sm_i, data_type="FLOAT", domain="POINT"
    )
    vel_new = vel2(na=nr_prv, nb=nr_sm, wp=w_pv_h, wq=w_sm)
    not_dying_all = boolean_math(
        boolean=boolean_math(boolean=dying, boolean_001=dying_sp, operation="OR"),
        operation="NOT",
    )
    survive = boolean_math(boolean=alive, boolean_001=not_dying_all, operation="AND")
    # A maximal simultaneous collapse can consume an entire LAV.  Its chosen
    # run head then retargets both flanks back to its own slot; that is an
    # exhausted component, not a reborn one-vertex ring.  Keep ordinary heads
    # (including 2-rings whose common neighbor is a distinct slot), but do not
    # leave this fully collapsed head live with nx == pv == self.
    self_f = input_index() * 1.0
    head_self = boolean_math(
        boolean=compare(a=nx_sm, b=self_f, operation="EQUAL"),
        boolean_001=compare(a=pv_hd, b=self_f, operation="EQUAL"),
        operation="AND",
    )
    keep_head = boolean_math(
        boolean=is_head,
        boolean_001=boolean_math(boolean=head_self, operation="NOT"),
        operation="AND",
    )
    keep = boolean_math(boolean=survive, boolean_001=keep_head, operation="OR")
    lv_new = switch(switch=keep, false=0.0, true=1.0, input_type="FLOAT")
    # Edge-event survivors anchor on the canonical collision point too —
    # a fast HEAD would otherwise plant its amplified self-integration
    # into the newborn anchor (same defect class, downstream). Split
    # heads keep the original p_death semantics untouched.
    ap_head = switch(switch=dying_sp, false=nd_c, true=p_death, input_type="VECTOR")
    ap_new = switch(switch=is_head, false=ap_f, true=ap_head, input_type="VECTOR")
    # Task #7: the reborn head's anchor TIME follows its anchor POSITION —
    # nd_c is the pair intersection at t_ev, so at_new must be t_ev on the
    # edge path (split heads keep the reviewed (p_death, t_min) pair).
    at_new = switch(
        switch=is_head,
        false=at_f,
        true=switch(
            switch=dying_sp, false=t_ev, true=t_min, input_type="FLOAT"
        ),
        input_type="FLOAT",
    )
    vl_new = switch(switch=is_head, false=vl_f, true=vel_new, input_type="VECTOR")
    nr_new = switch(switch=is_head, false=nr_f, true=nr_sm, input_type="VECTOR")
    ed_new = switch(switch=is_head, false=ed_f, true=ed_sm, input_type="FLOAT")
    nx_new = switch(switch=is_head, false=nx_f, true=nx_sm, input_type="FLOAT")
    w_new = switch(switch=is_head, false=w_f, true=w_sm, input_type="FLOAT")
    return (
        not_dying_all, is_head, nr_sm, nr_prv, pv_hd,
        lv_new, ap_new, at_new, vl_new, nr_new, ed_new, nx_new, w_new,
    )


@node_tree(id="opus.gnslice.fold.v1", target="geometry")
def skel_fold(
    done: Boolean, ring2_b: Boolean, dying: Boolean, dying_r: Boolean,
    zero_dur: Boolean,
    e6: Geometry, arcs: Geometry, caps: Geometry, ridge: Geometry,
    uarc: Geometry, warc: Geometry,
    is_A: Boolean, is_B: Boolean, iA: Integer, iB: Integer,
    a_a_x: Float, a_a_y: Float, a_b_x: Float, a_b_y: Float,
    front: Geometry, tnow: Float, f_dy: Geometry, dy_f: Float,
    f_sdy: Geometry, sdy_hd_f: Float, bc: Float, lc: Float,
    n_acc: Float, nr_sm: Vector, nr_prv: Vector, bo_f: Float, lav_f: Float,
    lv_f: Float,
    is_head: Boolean, lv_new: Float, ap_new: Vector, at_new: Float,
    vl_new: Vector, nr_new: Vector, ed_new: Float, nx_new: Float,
    w_new: Float, p_nx_ok: Boolean, p_nx_val: Float, p_pv_ok: Boolean,
    p_pv_val: Float, pv_hd: Float, ap_f: Vector, at_f: Float, vl_f: Vector,
    nr_f: Vector, ed_f: Float, w_f: Float, nx_f: Float, pv_f: Float,
    td_new_v: Float, td_f: Float, f_sm: Geometry,
) -> tuple[Geometry, Geometry, Boolean, Float, Boolean]:
    """S5 fold (structural step 11): branch select + done/err gating, Aw/Bw
    newborn recompute (deliberate keep, contract S2), virtual-merge
    retargets, the fold-priority _g switches, and the rebuild() call.
    `rebuild` itself stays keep-VERBATIM (contract: wall around it, never
    inside it) — this def is the wall. No zone specials in span — body
    byte-verbatim from the zone region.
    Outputs: front_rebuilt + arcs_out (zone states), is_ba + lav_B, and the
    per-newborn cross-LAV merge marker consumed by relabel.
    In-span-only names: hold, drop_ev_rec, arcs_event, Aw_*/Bw_* tuples,
    apv_i/apv_rt/w_cls0/bpv_src/bpv_i/bpv_hd/bpv_rt, *_pick, bo_B,
    detH, rf_head, rf_new_f, rf_pick, lv_g..td_g.
    """
    # --- branch select + done/err gating -------------------------------
    # Grove's switch() wrapper is declared `-> Float`, so a Geometry-typed
    # switch cannot satisfy the strict zone-state contract (measured:
    # [zone-state-mismatch]). Both branches are therefore selected at the
    # VALUE level for the front, and by mask-and-join for the arc records.
    # A3: hold is now PER-VERTEX (field): a terminated 2-ring member
    # freezes its own columns while other LAVs keep resolving; the
    # global `done` freezes everything.
    hold = boolean_math(boolean=done, boolean_001=ring2_b, operation="OR")
    owned_ev_rec = boolean_math(boolean=dying, boolean_001=dying_r, operation="OR")
    drop_unowned_ev_rec = boolean_math(boolean=owned_ev_rec, operation="NOT")
    drop_ev_rec = boolean_math(
        boolean=drop_unowned_ev_rec,
        boolean_001=boolean_math(boolean=zero_dur, boolean_001=hold, operation="OR"),
        operation="OR",
    )
    arcs_event = delete_geometry(
        geometry=e6, selection=drop_ev_rec, mode="ALL", domain="POINT"
    )
    arcs_out = join_geometry([arcs, arcs_event, caps, ridge, uarc, warc])

    # A5 store-chain rebase (SPEC 1): the rebuild tail lives behind a
    # GROUP boundary (rebuild, below) so the analyzer's tail-scope
    # warnings disappear; the runtime semantics are unchanged from the
    # opus inline chain. Store ORDER inside the group is load-bearing
    # (measured 2026-08-23): lv must precede pv (keep -> is_head reads
    # pv via ce_prv's index on the current chain). A3 note: hold is a
    # per-vertex field whose ring tests hop via samples PINNED to the
    # zone-input front, so it adds no context reads; `td` latches
    # termination per ring gated by global done only (hold would freeze
    # it exactly when it must latch). See the group's docstring.
    # Newborn columns (A = r's slot, B = spare slot): recomputed pool-
    # side from the matched site's slots (same _sp_scan math, so A/B
    # values are bitwise the site's). Fold priority: newborn > patch >
    # hold > edge batch. rf (task #14): ONE determinant classifier for
    # every birth — heads from detH (a merge can birth a reflex),
    # split children from the site's own detA/detB. The old
    # "newborns are convex (Aichholzer L2)" claim is unweighted-only
    # and was wrong in principle (Codex F1): measured, edge-born
    # reflex is common (9/15 corpus fixtures) and split-born never
    # occurred (0 in ~4,000+ births) — so this fix is behaviorally
    # inert on the constructible space, with the debug-build
    # birth-classifier guard (bviol) as the committed boundary.
    is_ba = boolean_math(boolean=is_B, boolean_001=is_A, operation="OR")
    # Re-cut (contract S6.3): both newborn recompute rows resolve through
    # sp_resolve; score never consumed here. The D3 duplicate spellings
    # collapse onto their canonical names -- Aw side reads its pv via
    # Aw_pv_r_f (the one textual rename this pass); the B side's r-row
    # dups (B_nx/B_nr/B_ed) keep their site spellings as aliases of the
    # same sockets.
    (
        Aw_s_raw, dd_A_lam, Aw_cls, Aw_nd, dd_A_b_f,
        dd_A_pv_a_f, Aw_pv_r_f, dd_A_nx_r_f, dd_A_nr_r, dd_A_ed_r,
        dd_A_ed_a, dd_A_ed_b, dd_A_ed_pa, dd_A_lav_r, dd_A_lav_a,
        dd_A_pos_a_s, dd_A_pos_b_s,
        Aw_A_nr, Aw_A_ed, Aw_A_nx, Aw_A_vl, Aw_A_w,
        dd_A_B_pv, dd_A_B_vl, dd_A_B_w, Aw_detA, dd_A_detB,
    ) = sp_resolve(geo=front, tnow=tnow, rsl=a_a_x, asl=a_a_y)
    (
        Bw_s_raw, dd_B_lam, dd_B_cls, Bw_nd, dd_B_b_f,
        Bw_pv_a_f, dd_B_pv_r_f, Bw_B_nx, Bw_B_nr, Bw_B_ed,
        dd_B_ed_a, dd_B_ed_b, dd_B_ed_pa, dd_B_lav_r, dd_B_lav_a,
        dd_B_pos_a_s, dd_B_pos_b_s,
        dd_B_A_nr, dd_B_A_ed, dd_B_A_nx, dd_B_A_vl, dd_B_A_w,
        Bw_B_pv, Bw_B_vl, Bw_B_w, dd_B_detA, Bw_detB,
    ) = sp_resolve(geo=front, tnow=tnow, rsl=a_b_x, asl=a_b_y)
    # Virtual-merge retargets for the newborn pointers (fx4/fx5): a
    # co-timed edge batch can kill the slot a newborn would point at;
    # the run's reborn head (same slot id, at the merge point) carries
    # the virtual vertex. A and B both pair with that reborn head: the
    # sequential edge-first oracle has already replaced the dying hit-edge
    # endpoint before it re-derives and applies the split.
    apv_i = float_to_int(float=Aw_pv_r_f, rounding_mode="ROUND")
    apv_rt = switch(
        switch=compare(
            a=sample_index(geometry=f_dy, value=dy_f, index=apv_i, data_type="FLOAT", domain="POINT"),
            b=0.5, operation="GREATER_THAN",
        ),
        false=Aw_pv_r_f,
        true=sample_index(geometry=f_sdy, value=sdy_hd_f, index=apv_i, data_type="FLOAT", domain="POINT"),
        input_type="FLOAT",
    )
    w_cls0 = compare(a=Aw_cls, b=0.5, operation="LESS_EQUAL")
    a_nr_rt = Aw_A_nr
    a_ed_rt = Aw_A_ed
    a_w_rt = Aw_A_w
    a_vl_rt = Aw_A_vl
    a_det_rt = Aw_detA
    b_vl_rt = Bw_B_vl
    b_det_rt = Bw_detB
    bpv_src = switch(switch=w_cls0, false=a_b_y, true=Bw_pv_a_f, input_type="FLOAT")
    bpv_i = float_to_int(float=bpv_src, rounding_mode="ROUND")
    bpv_hd = sample_index(
        geometry=f_sdy, value=sdy_hd_f, index=bpv_i, data_type="FLOAT", domain="POINT"
    )
    bpv_rt = switch(
        switch=compare(
            a=sample_index(geometry=f_dy, value=dy_f, index=bpv_i, data_type="FLOAT", domain="POINT"),
            b=0.5, operation="GREATER_THAN",
        ),
        false=Bw_B_pv,
        true=bpv_hd,
        input_type="FLOAT",
    )
    nd_pick = switch(switch=is_B, false=Aw_nd, true=Bw_nd, input_type="VECTOR")
    s_pick = switch(switch=is_B, false=Aw_s_raw, true=Bw_s_raw, input_type="FLOAT")
    vl_pick = switch(switch=is_B, false=a_vl_rt, true=b_vl_rt, input_type="VECTOR")
    nr_pick = switch(switch=is_B, false=a_nr_rt, true=Bw_B_nr, input_type="VECTOR")
    ed_pick = switch(switch=is_B, false=a_ed_rt, true=Bw_B_ed, input_type="FLOAT")
    anx_rt = Aw_A_nx
    nx_pick = switch(switch=is_B, false=anx_rt, true=Bw_B_nx, input_type="FLOAT")
    w_pick = switch(switch=is_B, false=a_w_rt, true=Bw_B_w, input_type="FLOAT")
    pv_pick = switch(switch=is_B, false=apv_rt, true=bpv_rt, input_type="FLOAT")
    # bo: A inherits r's bo (slot identity persists); B gets a fresh
    # value above ps (unique forever: bc grows monotonically).
    # ps read re-bound HERE (this store's chain state), not passed from
    # skel_arbitrate — a named-attribute field evaluates on the
    # consuming node's chain, which is the newborn cloud, not the
    # arbitration-time front.
    bo_B = math(
        value=math(
            value=input_named_attribute(name="ps", data_type="FLOAT"),
            value_001=math(value=bc, value_001=iB * 1.0, operation="ADD"),
            operation="ADD",
        ),
        value_001=1.0,
        operation="ADD",
    )
    lav_B = math(value=lc, value_001=iB * 1.0, operation="ADD")
    cross_A = compare(
        a=math(
            value=math(
                value=dd_A_lav_r, value_001=dd_A_lav_a,
                operation="SUBTRACT",
            ),
            operation="ABSOLUTE",
        ),
        b=0.5,
        operation="GREATER_THAN",
    )
    cross_B = compare(
        a=math(
            value=math(
                value=dd_B_lav_r, value_001=dd_B_lav_a,
                operation="SUBTRACT",
            ),
            operation="ABSOLUTE",
        ),
        b=0.5,
        operation="GREATER_THAN",
    )
    cross_merge = switch(
        switch=is_B, false=cross_A, true=cross_B, input_type="BOOLEAN"
    )
    detH = separate_xyz(
        vector=vector_math(vector=nr_prv, vector_001=nr_sm, operation="CROSS_PRODUCT")
    ).z
    # Task #14 (Fable V1 qual.): -1e-12 was an f64-style epsilon with
    # no f32 meaning. Stated window for the slack -1e-6: f32 sign
    # noise on normalized input normals is ~1e-7, and the smallest
    # |det| ever observed at a birth is >= 1e-5 (corpus + fx5
    # families + 6,000 randomized trials, ~9k births, 0 in band) —
    # the slack sits a decade above the noise floor and two below
    # the observed minimum.
    rf_head = compare(a=detH, b=-1e-6, operation="LESS_THAN")
    rf_new_f = switch(switch=rf_head, false=0.0, true=1.0, input_type="FLOAT")
    # A degenerate child (fx4/fx5) stays ALIVE: its 2-ring with the
    # reborn head is an ordinary live ring the ring2 caps terminate.
    lv_g = switch(switch=is_ba, false=switch(switch=hold, false=lv_new, true=lv_f, input_type="FLOAT"), true=1.0, input_type="FLOAT")
    ap_g = switch(switch=is_ba, false=switch(switch=hold, false=ap_new, true=ap_f, input_type="VECTOR"), true=nd_pick, input_type="VECTOR")
    at_g = switch(switch=is_ba, false=switch(switch=hold, false=at_new, true=at_f, input_type="FLOAT"), true=s_pick, input_type="FLOAT")
    vl_g = switch(switch=is_ba, false=switch(switch=hold, false=vl_new, true=vl_f, input_type="VECTOR"), true=vl_pick, input_type="VECTOR")
    nr_g = switch(switch=is_ba, false=switch(switch=hold, false=nr_new, true=nr_f, input_type="VECTOR"), true=nr_pick, input_type="VECTOR")
    ed_g = switch(switch=is_ba, false=switch(switch=hold, false=ed_new, true=ed_f, input_type="FLOAT"), true=ed_pick, input_type="FLOAT")
    # w persists per-slot: survivor keeps w_f (frozen under hold),
    # newborn/reborn takes the event's winning side weight.
    w_g = switch(switch=is_ba, false=switch(switch=hold, false=w_new, true=w_f, input_type="FLOAT"), true=w_pick, input_type="FLOAT")
    nx_g = switch(
        switch=is_B,
        false=switch(
            switch=is_A,
            false=switch(
                switch=p_nx_ok,
                false=switch(switch=hold, false=nx_new, true=nx_f, input_type="FLOAT"),
                true=p_nx_val,
                input_type="FLOAT",
            ),
            true=nx_pick,
            input_type="FLOAT",
        ),
        true=Bw_B_nx,
        input_type="FLOAT",
    )
    pv_g = switch(
        switch=is_B,
        false=switch(
            switch=is_A,
            false=switch(
                switch=p_pv_ok,
                false=switch(switch=hold, false=pv_hd, true=pv_f, input_type="FLOAT"),
                true=p_pv_val,
                input_type="FLOAT",
            ),
            true=pv_pick,
            input_type="FLOAT",
        ),
        true=bpv_rt,
        input_type="FLOAT",
    )
    bo_g = switch(switch=is_B, false=bo_f, true=bo_B, input_type="FLOAT")
    rf_pick = switch(
        switch=is_B,
        false=switch(
            switch=compare(a=a_det_rt, b=-1e-6, operation="LESS_THAN"),
            false=0.0,
            true=1.0,
            input_type="FLOAT",
        ),
        true=switch(
            switch=compare(a=b_det_rt, b=-1e-6, operation="LESS_THAN"),
            false=0.0,
            true=1.0,
            input_type="FLOAT",
        ),
        input_type="FLOAT",
    )
    rf_g = switch(
        switch=is_ba,
        # rf read re-bound HERE (post-arbitration front), not passed from
        # skel_split_scan — a named-attribute field evaluates on the
        # consuming node's chain state, which at this store is the
        # post-split/kill front, not the scan-time front.
        false=switch(
            switch=is_head,
            false=input_named_attribute(name="rf", data_type="FLOAT"),
            true=rf_new_f,
            input_type="FLOAT",
        ),
        true=rf_pick,
        input_type="FLOAT",
    )
    lav_g = switch(switch=is_B, false=lav_f, true=lav_B, input_type="FLOAT")
    td_g = switch(switch=done, false=switch(switch=is_ba, false=td_new_v, true=0.0, input_type="FLOAT"), true=td_f, input_type="FLOAT")
    front_rebuilt = rebuild(
        front=f_sm,
        ap=ap_g,
        at=at_g,
        vl=vl_g,
        nr=nr_g,
        ed=ed_g,
        nx=nx_g,
        pv=pv_g,
        lv=lv_g,
        td=td_g,
        bo=bo_g,
        rf=rf_g,
        lav=lav_g,
        w=w_g,
    )
    return (front_rebuilt, arcs_out, is_ba, lav_B, cross_merge)


@node_tree(id="opus.gnslice.relabel.v1", target="geometry")
def skel_relabel(
    front_rebuilt: Geometry, is_ba: Boolean, is_B: Boolean, lav_B: Float,
    lc: Float, n_acc: Float, iA: Integer, pool_n: Integer, cross_merge: Boolean,
) -> Geometry:
    """Newborn relabel (structural step 12): LAV re-stamp.

    An ordinary split seeds two fresh child ids (A: lc+n_acc+iA, B: lc+iB).
    A cross-LAV merge seeds both newborns with A's one fresh id so the joined
    circle becomes one LAV. `lavring` walks the seed(s) over full membership.
    """
    lav_A = math(
        value=math(value=lc, value_001=n_acc, operation="ADD"),
        value_001=iA * 1.0,
        operation="ADD",
    )
    lav_B_seed = switch(
        switch=cross_merge, false=lav_B, true=lav_A, input_type="FLOAT"
    )
    seed_anc = store_named_attribute(
        geometry=front_rebuilt,
        name="anc",
        value=switch(switch=is_ba, false=0.0, true=1.0, input_type="FLOAT"),
        data_type="FLOAT",
        domain="POINT",
    )
    seed_lvn = store_named_attribute(
        geometry=seed_anc,
        name="lvn",
        value=switch(
            switch=is_B, false=lav_A, true=lav_B_seed, input_type="FLOAT"
        ),
        data_type="FLOAT",
        domain="POINT",
    )
    front_walked = lavring(front=seed_lvn, steps=pool_n)
    return front_walked


@node_tree(id="opus.gnslice.clock.v1", target="geometry")
def skel_clock(
    done: Boolean, not_done: Boolean, t_min: Float, tnow: Float, it: Float,
    total_col: Boolean, any_site: Boolean, no_event: Boolean,
    ring2_b: Boolean, alive: Boolean, front: Geometry, maxiter: Integer,
    z_it: Integer, cap_ok: Boolean, n_acc_pre: Float, s_st: Geometry,
    pre_core: Boolean, det_bad: Boolean, det_ok: Boolean, xlav_b: Boolean,
    amb5_s_row: Boolean, amb5_e: Boolean, ec: Float, bc: Float, lc: Float,
    n_acc: Float, front_gd15: Geometry,
) -> tuple[Float, Float, Boolean, Float, Float, Float]:
    """Clock + zone tail (structural step 13): tnow/it advance, A3 done
    latch + stall detection, the A4 error-contract cascade (codes 1-7),
    and the bc/lc carrier advance. THE LAST bare zone `index` use lived
    here (last_iter budget check vs maxiter) — adapted to the z_it VALUE
    param per the step-8 law (Iteration, not element index).
    Outputs: tnow_out, it_out, done_out, ec_out, bc_out, lc_out.
    In-span-only names: stop_a, not_ring2, unterm_sel, n_unterm, all_term,
    done_raw, not_all_term, bad_raw, bad, last_iter, not_done_out,
    budget_err, cap_fail, det_fail_sum, det_fail, xlav_fail_sum, xlav_fail,
    amb5_s_sum, amb5_fail, stall_code, ec6..ec1, code_now, has_ec,
    ps_chk, nx_chk, pv_chk, nx_oob, pv_oob, ptr_bad_row, p3_sum, ptr_fail.
    """
    # tnow/it advance while the SOLVE is unfinished (global done) — with
    # multiple LAVs a terminated ring must not stall the clock for the
    # rings still resolving.
    tnow_out = switch(switch=done, false=t_min, true=tnow, input_type="FLOAT")
    it_out = switch(switch=done, false=it + 1.0, true=it, input_type="FLOAT")
    # Total collapse only stops when no split site dispatches (a split
    # rebirth keeps the wavefront alive).
    stop_a = boolean_math(
        boolean=boolean_math(
            boolean=total_col,
            boolean_001=boolean_math(boolean=any_site, operation="NOT"),
            operation="AND",
        ),
        boolean_001=no_event,
        operation="OR",
    )
    # A3: done latches when no live vertex is outside a terminated
    # 2-ring (multi-LAV safe: rings finish independently) or a global
    # stop condition fires. Stall (code 7) = no candidate while not
    # done.
    not_ring2 = boolean_math(boolean=ring2_b, operation="NOT")
    unterm_sel = boolean_math(boolean=alive, boolean_001=not_ring2, operation="AND")
    n_unterm = attribute_statistic(
        geometry=front,
        selection=unterm_sel,
        attribute=1.0,
        data_type="FLOAT",
        domain="POINT",
    ).sum
    all_term = compare(a=n_unterm, b=0.5, operation="LESS_THAN")
    done_raw = boolean_math(boolean=all_term, boolean_001=stop_a, operation="OR")
    # A stall is no candidate while NOT done AND not in a terminal
    # configuration — the terminal iteration (caps pending, every
    # candidate exactly 1e9 after simultaneous death) would otherwise
    # latch a false stall (measured: rect6x2 under A3).
    not_all_term = boolean_math(boolean=all_term, operation="NOT")
    bad_raw = boolean_math(
        boolean=no_event, boolean_001=not_all_term, operation="AND"
    )
    bad = boolean_math(boolean=bad_raw, boolean_001=not_done, operation="AND")
    done_out = boolean_math(boolean=done, boolean_001=done_raw, operation="OR")
    # A4 error contract: 2 = iteration_budget (zone exits unfinished on
    # its last iteration), 7 = stall (no candidate while non-terminal;
    # A3 replaces the global stall with per-ring detection). First error
    # sticks across iterations; budget wins a same-iteration tie.
    last_iter = compare(
        a=z_it * 1.0, b=maxiter - 1.5, operation="GREATER_THAN"
    )
    not_done_out = boolean_math(boolean=done_out, operation="NOT")
    budget_err = boolean_math(
        boolean=last_iter, boolean_001=not_done_out, operation="AND"
    )
    # A4 error priority within an iteration: 2 budget > 1 capacity >
    # 3 pointer bounds > 4 collinear det > 6 cross-LAV > 7 stall; first
    # error sticks across iterations (has_ec below).
    cap_fail = boolean_math(
        boolean=boolean_math(boolean=cap_ok, operation="NOT"),
        boolean_001=compare(a=n_acc_pre, b=0.5, operation="GREATER_THAN"),
        operation="AND",
    )
    det_fail_sum = attribute_statistic(
        geometry=s_st,
        selection=boolean_math(boolean=pre_core, boolean_001=det_bad, operation="AND"),
        attribute=1.0,
        data_type="FLOAT",
        domain="POINT",
    ).sum
    det_fail = compare(a=det_fail_sum, b=0.5, operation="GREATER_THAN")
    xlav_fail_sum = attribute_statistic(
        geometry=s_st,
        selection=boolean_math(
            boolean=boolean_math(boolean=pre_core, boolean_001=det_ok, operation="AND"),
            boolean_001=xlav_b,
            operation="AND",
        ),
        attribute=1.0,
        data_type="FLOAT",
        domain="POINT",
    ).sum
    xlav_fail = compare(a=xlav_fail_sum, b=0.5, operation="GREATER_THAN")
    # Code 5 aggregate: boundary-adjacent candidate on either side
    # (edge batch gate or split arbitration gate) is a quantization
    # coin-flip on batch membership. Priority: 4 collinear det > 5
    # ambiguous extent band > 6 cross-LAV (first-error-sticks).
    amb5_s_sum = attribute_statistic(
        geometry=s_st, selection=amb5_s_row, attribute=1.0,
        data_type="FLOAT", domain="POINT",
    ).sum
    amb5_fail = boolean_math(
        boolean=amb5_e,
        boolean_001=compare(a=amb5_s_sum, b=0.5, operation="GREATER_THAN"),
        operation="OR",
    )
    stall_code = switch(switch=bad, false=0.0, true=7.0, input_type="FLOAT")
    ec6 = switch(switch=xlav_fail, false=stall_code, true=6.0, input_type="FLOAT")
    ec5 = switch(switch=amb5_fail, false=ec6, true=5.0, input_type="FLOAT")
    ec4 = switch(switch=det_fail, false=ec5, true=4.0, input_type="FLOAT")
    # A4 code 3 (D3): invalid pointer sample — a live slot's nx/pv outside
    # the pool [0, ps) would dereference garbage next scan. Bounds-only
    # (cheap); pointer-liveness targets are A3's termination job.
    ps_chk = input_named_attribute(name="ps", data_type="FLOAT")
    nx_chk = input_named_attribute(name="nx", data_type="FLOAT")
    pv_chk = input_named_attribute(name="pv", data_type="FLOAT")
    nx_oob = boolean_math(
        boolean=compare(a=nx_chk, b=-0.5, operation="LESS_THAN"),
        boolean_001=compare(
            a=nx_chk,
            b=math(value=ps_chk, value_001=0.5, operation="SUBTRACT"),
            operation="GREATER_THAN",
        ),
        operation="OR",
    )
    pv_oob = boolean_math(
        boolean=compare(a=pv_chk, b=-0.5, operation="LESS_THAN"),
        boolean_001=compare(
            a=pv_chk,
            b=math(value=ps_chk, value_001=0.5, operation="SUBTRACT"),
            operation="GREATER_THAN",
        ),
        operation="OR",
    )
    ptr_bad_row = boolean_math(
        boolean=alive,
        boolean_001=boolean_math(boolean=nx_oob, boolean_001=pv_oob, operation="OR"),
        operation="AND",
    )
    p3_sum = attribute_statistic(
        geometry=front_gd15, selection=ptr_bad_row, attribute=1.0,
        data_type="FLOAT", domain="POINT",
    ).sum
    ptr_fail = compare(a=p3_sum, b=0.5, operation="GREATER_THAN")
    ec3 = switch(switch=ptr_fail, false=ec4, true=3.0, input_type="FLOAT")
    ec1 = switch(switch=cap_fail, false=ec3, true=1.0, input_type="FLOAT")
    code_now = switch(
        switch=budget_err, false=ec1, true=2.0, input_type="FLOAT"
    )
    has_ec = compare(a=ec, b=0.5, operation="GREATER_THAN")
    ec_out = switch(switch=has_ec, false=code_now, true=ec, input_type="FLOAT")
    bc_out = switch(
        switch=done, false=math(value=bc, value_001=n_acc, operation="ADD"), true=bc, input_type="FLOAT"
    )
    lc_out = switch(
        switch=done, false=math(
            value=lc,
            value_001=math(value=n_acc, value_001=n_acc, operation="ADD"),
            operation="ADD",
        ), true=lc, input_type="FLOAT"
    )
    return (tnow_out, it_out, done_out, ec_out, bc_out, lc_out)


@node_tree(id="opus.gnslice.ring_legacy.v1", target="geometry")
def skel_ring_legacy(
    outline: Geometry,
) -> tuple[Geometry, Float, Geometry, Float, Integer]:
    """Prepare S1 (structural step 14): the ordered corner ring from the
    input face — corner-rank stamp, weight carrier resolve (absent->1.0
    HERE on mesh points as wq1), optional point-domain gable resolve
    (absent->0 as gq0), curve reordering, positional re-seating on a fresh
    point cloud. No zone specials (roof body; input_index() is correct
    element-index semantics here).
    Outputs: ring, ring_w (field), mesh_w (wq1-stamped mesh points — the
    geometry the downstream weight-validation statistics evaluate on),
    nf (corner count float), ndom (int).
    In-span-only names: rk_corner, m_corner, m_point, mesh_pts, w_attr,
    w_resolved, g_attr, g_resolved, ring_curve, ring_slots, ring_pos.
    """
    ndom = attribute_domain_size(geometry=outline, component="MESH")
    nf = ndom * 1.0
    rk_corner = face_of_corner(corner_index=input_index()).index_in_face
    m_corner = store_named_attribute(
        geometry=outline,
        name="rkc",
        value=rk_corner * 1.0,
        data_type="FLOAT",
        domain="CORNER",
    )
    m_point = store_named_attribute(
        geometry=m_corner,
        name="rk",
        value=input_named_attribute(name="rkc", data_type="FLOAT"),
        data_type="FLOAT",
        domain="POINT",
    )
    mesh_pts = mesh_to_points(mesh=m_point, mode="VERTICES")
    # Weight carrier (SPEC 1): named float `w` on the input MESH POINT
    # domain; vertex i owns edge i->i+1. Exists is a property of the
    # geometry the field evaluates ON, so resolve absent->1.0 HERE on the
    # mesh points and store it as a real attribute (`wq1`) that survives
    # the curve conversion — never test Exists on the far side.
    w_attr = input_named_attribute(name="w", data_type="FLOAT")
    w_resolved = switch(
        switch=w_attr.exists, false=1.0, true=w_attr, input_type="FLOAT"
    )
    mesh_w = store_named_attribute(
        geometry=mesh_pts,
        name="wq1",
        value=w_resolved,
        data_type="FLOAT",
        domain="POINT",
    )
    g_attr = input_named_attribute(name="gable", data_type="INT")
    g_resolved = switch(
        switch=g_attr.exists, false=0, true=g_attr, input_type="INT"
    )
    mesh_g = store_named_attribute(
        geometry=mesh_w,
        name="gq0",
        value=g_resolved,
        data_type="INT",
        domain="POINT",
    )
    ring_curve = points_to_curves(
        points=mesh_g,
        curve_group_id=0,
        weight=input_named_attribute(name="rk", data_type="FLOAT"),
    )
    ring_slots = points(count=ndom)
    ring_pos = sample_index(
        geometry=ring_curve,
        value=input_position(),
        index=input_index(),
        data_type="FLOAT_VECTOR",
        domain="POINT",
    )
    ring_w = sample_index(
        geometry=ring_curve,
        value=input_named_attribute(name="wq1", data_type="FLOAT"),
        index=input_index(),
        data_type="FLOAT",
        domain="POINT",
    )
    ring_g = sample_index(
        geometry=ring_curve,
        value=input_named_attribute(name="gq0", data_type="INT"),
        index=input_index(),
        data_type="INT",
        domain="POINT",
    )
    ring_pos_geo = set_position(geometry=ring_slots, position=ring_pos)
    ring = store_named_attribute(
        geometry=ring_pos_geo,
        name="g0",
        value=ring_g,
        data_type="INT",
        domain="POINT",
    )
    return (ring, ring_w, mesh_g, nf, ndom)


@node_tree(id="opus.gnslice.ring_derived.v1", target="geometry")
def skel_ring_derived(
    outline: Geometry,
    max_split_pairs: Integer = 4096,
    weld_distance: Float = 0.00001,
) -> tuple[Geometry, Float, Integer, Boolean, Boolean]:
    """Normalize a selected markerless multi-face region from its boundary.

    Generated curve indices are transient addresses only. Exact anchors,
    containment depth, winding-normalized local rank, and hole-anchor order
    produce the semantic row keys consumed by the existing solver.
    """
    edge_faces = input_mesh_edge_neighbors().face_count
    boundary = compare(a=edge_faces, b=1, operation="EQUAL", data_type="INT")
    edge_stats = attribute_statistic(
        geometry=outline, attribute=edge_faces * 1.0,
        data_type="FLOAT", domain="EDGE",
    )
    edge_bad = boolean_math(
        boolean=compare(a=edge_stats.min, b=1.0, operation="LESS_THAN"),
        boolean_001=compare(a=edge_stats.max, b=2.0, operation="GREATER_THAN"),
        operation="OR",
    )
    vertex_degree = input_mesh_vertex_neighbors().vertex_count
    vertex_stats = attribute_statistic(
        geometry=outline, attribute=vertex_degree * 1.0,
        data_type="FLOAT", domain="POINT",
    )
    loose_vertex_bad = compare(a=vertex_stats.min, b=1.0, operation="LESS_THAN")
    island_index = input_mesh_island().island_index
    island_stats = attribute_statistic(
        geometry=outline, attribute=island_index * 1.0,
        data_type="FLOAT", domain="POINT",
    )
    island_bad = compare(
        a=island_stats.max, b=island_stats.min, operation="GREATER_THAN"
    )
    face_group = edges_to_face_groups(boundary_edges=boundary).face_group_id
    face_group_stats = attribute_statistic(
        geometry=outline, attribute=face_group * 1.0,
        data_type="FLOAT", domain="FACE",
    )
    face_group_bad = compare(
        a=face_group_stats.max, b=face_group_stats.min,
        operation="GREATER_THAN",
    )
    mesh_dims = attribute_domain_size(geometry=outline, component="MESH")

    boundary_mesh = delete_geometry(
        geometry=outline,
        selection=boolean_math(boolean=boundary, operation="NOT"),
        domain="EDGE", mode="EDGE_FACE",
    )
    boundary_degree = input_mesh_vertex_neighbors().vertex_count
    used_boundary_vertex = compare(
        a=boundary_degree, b=0, operation="GREATER_THAN", data_type="INT"
    )
    boundary_degree_stats = attribute_statistic(
        geometry=boundary_mesh, selection=used_boundary_vertex,
        attribute=boundary_degree * 1.0, data_type="FLOAT", domain="POINT",
    )
    degree_bad = boolean_math(
        boolean=compare(a=boundary_degree_stats.min, b=2.0, operation="LESS_THAN"),
        boolean_001=compare(a=boundary_degree_stats.max, b=2.0, operation="GREATER_THAN"),
        operation="OR",
    )

    boundary_curves = mesh_to_curve(
        mesh=outline, selection=boundary, mode="EDGES"
    )
    curve_dims = attribute_domain_size(geometry=boundary_curves, component="CURVE")
    m = curve_dims.point_count
    chi_ve = integer_math(
        value=mesh_dims.point_count, value_001=mesh_dims.edge_count,
        operation="SUBTRACT",
    )
    chi = integer_math(
        value=chi_ve, value_001=mesh_dims.face_count, operation="ADD"
    )
    expected_chi = integer_math(
        value=2, value_001=curve_dims.spline_count, operation="SUBTRACT"
    )
    euler_bad = compare(
        a=chi, b=expected_chi, operation="NOT_EQUAL", data_type="INT"
    )
    cyclic_bad_count = attribute_statistic(
        geometry=boundary_curves,
        attribute=switch(
            switch=input_spline_cyclic(), false=1.0, true=0.0,
            input_type="FLOAT",
        ),
        data_type="FLOAT", domain="CURVE",
    ).sum
    cyclic_bad = compare(a=cyclic_bad_count, b=0.0, operation="GREATER_THAN")

    curve_lookup = curve_of_point(point_index=input_index())
    curve_index = curve_lookup.curve_index
    index_in_curve = curve_lookup.index_in_curve
    curve_point_count = points_of_curve(curve_index=curve_index).total
    next_original = offset_point_in_curve(
        point_index=input_index(), offset=1
    ).point_index
    next_position = sample_index(
        geometry=boundary_curves, value=input_position(), index=next_original,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    # P1-T12: evaluate shoelace terms in a per-curve local frame.  Absolute
    # products cancel algebraically but lose the contour area in float32 far
    # from the world origin; subtracting any point on the same closed curve
    # preserves the signed area and keeps the operands at contour scale.
    curve_first_index = points_of_curve(
        curve_index=curve_index, sort_index=0
    )
    curve_origin = sample_index(
        geometry=boundary_curves,
        value=input_position(),
        index=curve_first_index,
        data_type="FLOAT_VECTOR",
        domain="POINT",
    )
    local_position = vector_math(
        vector=input_position(), vector_001=curve_origin, operation="SUBTRACT"
    )
    local_next_position = vector_math(
        vector=next_position, vector_001=curve_origin, operation="SUBTRACT"
    )
    xyz = separate_xyz(vector=local_position)
    next_xyz = separate_xyz(vector=local_next_position)
    area_total = accumulate_field(
        value=xyz.x * next_xyz.y - next_xyz.x * xyz.y,
        group_id=curve_index, data_type="FLOAT", domain="POINT",
    ).total
    edge_vector = vector_math(
        vector=local_next_position, vector_001=local_position, operation="SUBTRACT"
    )
    perimeter_total = accumulate_field(
        value=vector_math(vector=edge_vector, operation="LENGTH").value,
        group_id=curve_index, data_type="FLOAT", domain="POINT",
    ).total
    # P1-T14: a nonzero shoelace result is not meaningful below the native
    # float32 scale of its contour.  Perimeter is available per curve without
    # a geometry-domain mutation, and perimeter^2 is a conservative extent^2
    # proxy.  The second term also keeps the floor above one weld-distance
    # strip around the component.  2^-24 is the binary32 unit roundoff.
    relative_area_epsilon = 5.960464477539063e-8
    relative_area_floor = (
        perimeter_total * perimeter_total * relative_area_epsilon
    )
    weld_area_floor = perimeter_total * weld_distance
    area_floor = math(
        value=relative_area_floor, value_001=weld_area_floor, operation="MAXIMUM"
    )
    tagged_ci = store_named_attribute(
        geometry=boundary_curves, name="_dci", value=curve_index,
        data_type="INT", domain="POINT",
    )
    tagged_k = store_named_attribute(
        geometry=tagged_ci, name="_dk", value=index_in_curve,
        data_type="INT", domain="POINT",
    )
    tagged_n = store_named_attribute(
        geometry=tagged_k, name="_dn", value=curve_point_count,
        data_type="INT", domain="POINT",
    )
    tagged_next = store_named_attribute(
        geometry=tagged_n, name="_dnx", value=next_original,
        data_type="INT", domain="POINT",
    )
    tagged_area = store_named_attribute(
        geometry=tagged_next, name="_darea", value=area_total,
        data_type="FLOAT", domain="POINT",
    )
    tagged_area_floor = store_named_attribute(
        geometry=tagged_area, name="_darea_floor", value=area_floor,
        data_type="FLOAT", domain="POINT",
    )
    rows_raw = curve_to_points(curve=tagged_area_floor, mode="EVALUATED").points

    row_xyz = separate_xyz(vector=input_position())
    finite_x = compare(a=row_xyz.x - row_xyz.x, b=0.0, operation="EQUAL")
    finite_y = compare(a=row_xyz.y - row_xyz.y, b=0.0, operation="EQUAL")
    finite_z = compare(a=row_xyz.z - row_xyz.z, b=0.0, operation="EQUAL")
    finite_xy = boolean_math(boolean=finite_x, boolean_001=finite_y, operation="AND")
    finite_xyz = boolean_math(boolean=finite_xy, boolean_001=finite_z, operation="AND")
    planar = compare(
        a=math(value=row_xyz.z, operation="ABSOLUTE"),
        b=weld_distance, operation="LESS_EQUAL",
    )
    # P1-T13 numeric envelope: keep two-component float32 products below
    # 2**121, leaving exponent headroom below the 2**128 overflow boundary.
    # The solver is local-frame (T12), but adapter predicates and legacy
    # compatibility still must reject extreme world coordinates explicitly.
    numeric_coordinate_limit = 1.152921504606847e18  # 2**60
    coordinate_too_large = boolean_math(
        boolean=compare(
            a=math(value=row_xyz.x, operation="ABSOLUTE"),
            b=numeric_coordinate_limit,
            operation="GREATER_THAN",
        ),
        boolean_001=compare(
            a=math(value=row_xyz.y, operation="ABSOLUTE"),
            b=numeric_coordinate_limit,
            operation="GREATER_THAN",
        ),
        operation="OR",
    )
    point_bad = boolean_math(
        boolean=boolean_math(boolean=finite_xyz, operation="NOT"),
        boolean_001=boolean_math(
            boolean=boolean_math(boolean=planar, operation="NOT"),
            boolean_001=coordinate_too_large,
            operation="OR",
        ),
        operation="OR",
    )
    point_bad_count = attribute_statistic(
        geometry=rows_raw,
        attribute=switch(
            switch=point_bad, false=0.0, true=1.0, input_type="FLOAT"
        ),
        data_type="FLOAT", domain="POINT",
    ).sum
    topology_bad = boolean_math(
        boolean=boolean_math(
            boolean=boolean_math(
                boolean=edge_bad, boolean_001=loose_vertex_bad, operation="OR"
            ),
            boolean_001=boolean_math(
                boolean=island_bad, boolean_001=face_group_bad, operation="OR"
            ),
            operation="OR",
        ),
        boolean_001=boolean_math(
            boolean=degree_bad, boolean_001=euler_bad, operation="OR"
        ),
        operation="OR",
    )
    cloud_free_bad = boolean_math(
        boolean=boolean_math(boolean=topology_bad, boolean_001=cyclic_bad, operation="OR"),
        boolean_001=compare(a=point_bad_count, b=0.0, operation="GREATER_THAN"),
        operation="OR",
    )

    raw_pair_count = math(
        value=m * 1.0, value_001=m * 1.0, operation="MULTIPLY"
    )
    pair_limit = max_split_pairs * 1.0
    # P1-T15: the current pair ordinal/decode carrier is binary32.  Keep every
    # admitted ordinal at or below its last contiguous exact integer, 2**24,
    # and reject an over-cap public limit before either M*M cloud is live.
    pair_address_m_cap = 4096
    pair_address_ordinal_cap = 16777216
    m_over_pair_address_cap = compare(
        a=m,
        b=pair_address_m_cap,
        data_type="INT",
        operation="GREATER_THAN",
    )
    pair_limit_over_address_cap = compare(
        a=max_split_pairs,
        b=pair_address_ordinal_cap,
        data_type="INT",
        operation="GREATER_THAN",
    )
    pair_address_cap_bad = boolean_math(
        boolean=m_over_pair_address_cap,
        boolean_001=pair_limit_over_address_cap,
        operation="OR",
    )
    pair_count_over_limit = compare(
        a=raw_pair_count, b=pair_limit, operation="GREATER_THAN"
    )
    c1_bad = boolean_math(
        boolean=pair_count_over_limit,
        boolean_001=pair_address_cap_bad,
        operation="OR",
    )
    clouds_enabled = boolean_math(
        boolean=boolean_math(boolean=cloud_free_bad, operation="NOT"),
        boolean_001=boolean_math(boolean=c1_bad, operation="NOT"),
        operation="AND",
    )
    rows = switch(
        switch=clouds_enabled, false=points(count=0), true=rows_raw,
        input_type="GEOMETRY",
    )
    pair_count = float_to_int(
        float=math(value=raw_pair_count, value_001=pair_limit, operation="MINIMUM"),
        rounding_mode="ROUND",
    )
    pair_points = points(
        count=switch(
            switch=clouds_enabled, false=0, true=pair_count, input_type="INT"
        )
    )
    pair_ordinal = input_index() * 1.0
    m_float = m * 1.0
    pair_i = float_to_int(
        float=math(
            value=math(value=pair_ordinal, value_001=m_float, operation="DIVIDE"),
            operation="FLOOR",
        ),
        rounding_mode="ROUND",
    )
    pair_j = float_to_int(
        float=math(value=pair_ordinal, value_001=m_float, operation="MODULO"),
        rounding_mode="ROUND",
    )
    pos_i = sample_index(
        geometry=rows, value=input_position(), index=pair_i,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    pos_j = sample_index(
        geometry=rows, value=input_position(), index=pair_j,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    ci_i = sample_index(
        geometry=rows, value=input_named_attribute(name="_dci", data_type="INT"),
        index=pair_i, data_type="INT", domain="POINT",
    )
    ci_j = sample_index(
        geometry=rows, value=input_named_attribute(name="_dci", data_type="INT"),
        index=pair_j, data_type="INT", domain="POINT",
    )
    p_i = separate_xyz(vector=pos_i)
    p_j = separate_xyz(vector=pos_j)
    x_equal = boolean_math(
        boolean=boolean_math(
            boolean=compare(a=p_i.x, b=p_j.x, operation="LESS_THAN"),
            operation="NOT",
        ),
        boolean_001=boolean_math(
            boolean=compare(a=p_j.x, b=p_i.x, operation="LESS_THAN"),
            operation="NOT",
        ),
        operation="AND",
    )
    j_before_i = boolean_math(
        boolean=compare(a=p_j.x, b=p_i.x, operation="LESS_THAN"),
        boolean_001=boolean_math(
            boolean=x_equal,
            boolean_001=compare(a=p_j.y, b=p_i.y, operation="LESS_THAN"),
            operation="AND",
        ),
        operation="OR",
    )
    same_component = compare(
        a=ci_i, b=ci_j, operation="EQUAL", data_type="INT"
    )
    less_same = boolean_math(
        boolean=same_component, boolean_001=j_before_i, operation="AND"
    )
    less_total = accumulate_field(
        value=switch(
            switch=less_same, false=0.0, true=1.0, input_type="FLOAT"
        ),
        group_id=pair_i, data_type="FLOAT", domain="POINT",
    ).total
    row_pair_start = float_to_int(
        float=input_index() * m_float, rounding_mode="ROUND"
    )
    less_for_row = sample_index(
        geometry=pair_points, value=less_total, index=row_pair_start,
        data_type="FLOAT", domain="POINT",
    )
    is_anchor = compare(a=less_for_row, b=0.0, operation="LESS_EQUAL")
    row_ci = input_named_attribute(name="_dci", data_type="INT")
    anchor_index_total = accumulate_field(
        value=switch(
            switch=is_anchor, false=0.0, true=input_index() * 1.0,
            input_type="FLOAT",
        ),
        group_id=row_ci, data_type="FLOAT", domain="POINT",
    ).total
    anchor_index = float_to_int(float=anchor_index_total, rounding_mode="ROUND")
    anchor_position = sample_index(
        geometry=rows, value=input_position(), index=anchor_index,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    anchor_k = sample_index(
        geometry=rows, value=input_named_attribute(name="_dk", data_type="INT"),
        index=anchor_index, data_type="INT", domain="POINT",
    )
    rows_anchor = store_named_attribute(
        geometry=rows, name="_danchor", value=is_anchor,
        data_type="BOOLEAN", domain="POINT",
    )
    rows_anchor_pos = store_named_attribute(
        geometry=rows_anchor, name="_dapos", value=anchor_position,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    rows_anchor_k = store_named_attribute(
        geometry=rows_anchor_pos, name="_dak", value=anchor_k,
        data_type="INT", domain="POINT",
    )

    pair_points_2 = points(
        count=switch(
            switch=clouds_enabled, false=0, true=pair_count, input_type="INT"
        )
    )
    pair2_ordinal = input_index() * 1.0
    pair2_i = float_to_int(
        float=math(
            value=math(value=pair2_ordinal, value_001=m_float, operation="DIVIDE"),
            operation="FLOOR",
        ),
        rounding_mode="ROUND",
    )
    pair2_j = float_to_int(
        float=math(value=pair2_ordinal, value_001=m_float, operation="MODULO"),
        rounding_mode="ROUND",
    )
    edge_i_start = sample_index(
        geometry=rows_anchor_k, value=input_position(), index=pair2_i,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    edge_i_next_index = sample_index(
        geometry=rows_anchor_k,
        value=input_named_attribute(name="_dnx", data_type="INT"),
        index=pair2_i, data_type="INT", domain="POINT",
    )
    edge_i_end = sample_index(
        geometry=rows_anchor_k, value=input_position(), index=edge_i_next_index,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    target_anchor = sample_index(
        geometry=rows_anchor_k,
        value=input_named_attribute(name="_dapos", data_type="FLOAT_VECTOR"),
        index=pair2_i, data_type="FLOAT_VECTOR", domain="POINT",
    )
    edge_start = sample_index(
        geometry=rows_anchor_k, value=input_position(), index=pair2_j,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    edge_next_index = sample_index(
        geometry=rows_anchor_k,
        value=input_named_attribute(name="_dnx", data_type="INT"),
        index=pair2_j, data_type="INT", domain="POINT",
    )
    edge_end = sample_index(
        geometry=rows_anchor_k, value=input_position(), index=edge_next_index,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    target_ci = sample_index(
        geometry=rows_anchor_k,
        value=input_named_attribute(name="_dci", data_type="INT"),
        index=pair2_i, data_type="INT", domain="POINT",
    )
    edge_ci = sample_index(
        geometry=rows_anchor_k,
        value=input_named_attribute(name="_dci", data_type="INT"),
        index=pair2_j, data_type="INT", domain="POINT",
    )
    edge_i_a_xyz = separate_xyz(vector=edge_i_start)
    edge_i_b_xyz = separate_xyz(vector=edge_i_end)
    target_xyz = separate_xyz(vector=target_anchor)
    edge_a_xyz = separate_xyz(vector=edge_start)
    edge_b_xyz = separate_xyz(vector=edge_end)

    i_dx = edge_i_b_xyz.x - edge_i_a_xyz.x
    i_dy = edge_i_b_xyz.y - edge_i_a_xyz.y
    j_dx = edge_b_xyz.x - edge_a_xyz.x
    j_dy = edge_b_xyz.y - edge_a_xyz.y
    orient_i_ja = (
        i_dx * (edge_a_xyz.y - edge_i_a_xyz.y)
        - i_dy * (edge_a_xyz.x - edge_i_a_xyz.x)
    )
    orient_i_jb = (
        i_dx * (edge_b_xyz.y - edge_i_a_xyz.y)
        - i_dy * (edge_b_xyz.x - edge_i_a_xyz.x)
    )
    orient_j_ia = (
        j_dx * (edge_i_a_xyz.y - edge_a_xyz.y)
        - j_dy * (edge_i_a_xyz.x - edge_a_xyz.x)
    )
    orient_j_ib = (
        j_dx * (edge_i_b_xyz.y - edge_a_xyz.y)
        - j_dy * (edge_i_b_xyz.x - edge_a_xyz.x)
    )
    sign_i_ja = float_to_int(
        float=math(value=orient_i_ja, operation="SIGN"), rounding_mode="ROUND"
    )
    sign_i_jb = float_to_int(
        float=math(value=orient_i_jb, operation="SIGN"), rounding_mode="ROUND"
    )
    sign_j_ia = float_to_int(
        float=math(value=orient_j_ia, operation="SIGN"), rounding_mode="ROUND"
    )
    sign_j_ib = float_to_int(
        float=math(value=orient_j_ib, operation="SIGN"), rounding_mode="ROUND"
    )
    i_straddles_j = boolean_math(
        boolean=boolean_math(
            boolean=compare(
                a=sign_i_ja, b=0, operation="LESS_THAN", data_type="INT"
            ),
            boolean_001=compare(
                a=sign_i_jb, b=0, operation="GREATER_THAN", data_type="INT"
            ),
            operation="AND",
        ),
        boolean_001=boolean_math(
            boolean=compare(
                a=sign_i_ja, b=0, operation="GREATER_THAN", data_type="INT"
            ),
            boolean_001=compare(
                a=sign_i_jb, b=0, operation="LESS_THAN", data_type="INT"
            ),
            operation="AND",
        ),
        operation="OR",
    )
    j_straddles_i = boolean_math(
        boolean=boolean_math(
            boolean=compare(
                a=sign_j_ia, b=0, operation="LESS_THAN", data_type="INT"
            ),
            boolean_001=compare(
                a=sign_j_ib, b=0, operation="GREATER_THAN", data_type="INT"
            ),
            operation="AND",
        ),
        boolean_001=boolean_math(
            boolean=compare(
                a=sign_j_ia, b=0, operation="GREATER_THAN", data_type="INT"
            ),
            boolean_001=compare(
                a=sign_j_ib, b=0, operation="LESS_THAN", data_type="INT"
            ),
            operation="AND",
        ),
        operation="OR",
    )
    same_edge = compare(a=pair2_i, b=pair2_j, operation="EQUAL", data_type="INT")
    adjacent_edge = boolean_math(
        boolean=same_edge,
        boolean_001=boolean_math(
            boolean=compare(
                a=pair2_j, b=edge_i_next_index, operation="EQUAL", data_type="INT"
            ),
            boolean_001=compare(
                a=pair2_i, b=edge_next_index, operation="EQUAL", data_type="INT"
            ),
            operation="OR",
        ),
        operation="OR",
    )
    proper_cross = boolean_math(
        boolean=boolean_math(boolean=adjacent_edge, operation="NOT"),
        boolean_001=boolean_math(
            boolean=i_straddles_j, boolean_001=j_straddles_i, operation="AND"
        ),
        operation="AND",
    )

    # P1-T11: use this existing M x M carrier for both strict crossings and
    # the declared edge-clearance envelope.  Check each unordered,
    # non-adjacent pair once; adjacent edges necessarily meet at a vertex.
    ordered_pair = compare(
        a=pair2_i, b=pair2_j, operation="LESS_THAN", data_type="INT"
    )
    check_pair = boolean_math(
        boolean=ordered_pair,
        boolean_001=boolean_math(boolean=adjacent_edge, operation="NOT"),
        operation="AND",
    )
    edge_i_vector = vector_math(
        vector=edge_i_end, vector_001=edge_i_start, operation="SUBTRACT"
    )
    edge_j_vector = vector_math(
        vector=edge_end, vector_001=edge_start, operation="SUBTRACT"
    )
    j_start_from_i = vector_math(
        vector=edge_start, vector_001=edge_i_start, operation="SUBTRACT"
    )
    j_end_from_i = vector_math(
        vector=edge_end, vector_001=edge_i_start, operation="SUBTRACT"
    )
    i_start_from_j = vector_math(
        vector=edge_i_start, vector_001=edge_start, operation="SUBTRACT"
    )
    i_end_from_j = vector_math(
        vector=edge_i_end, vector_001=edge_start, operation="SUBTRACT"
    )
    edge_i_den = math(
        value=vector_math(
            vector=edge_i_vector,
            vector_001=edge_i_vector,
            operation="DOT_PRODUCT",
        ).value,
        value_001=1e-20,
        operation="MAXIMUM",
    )
    edge_j_den = math(
        value=vector_math(
            vector=edge_j_vector,
            vector_001=edge_j_vector,
            operation="DOT_PRODUCT",
        ).value,
        value_001=1e-20,
        operation="MAXIMUM",
    )
    t_j_start_on_i = math(
        value=math(
            value=vector_math(
                vector=j_start_from_i,
                vector_001=edge_i_vector,
                operation="DOT_PRODUCT",
            ).value
            / edge_i_den,
            value_001=0.0,
            operation="MAXIMUM",
        ),
        value_001=1.0,
        operation="MINIMUM",
    )
    t_j_end_on_i = math(
        value=math(
            value=vector_math(
                vector=j_end_from_i,
                vector_001=edge_i_vector,
                operation="DOT_PRODUCT",
            ).value
            / edge_i_den,
            value_001=0.0,
            operation="MAXIMUM",
        ),
        value_001=1.0,
        operation="MINIMUM",
    )
    t_i_start_on_j = math(
        value=math(
            value=vector_math(
                vector=i_start_from_j,
                vector_001=edge_j_vector,
                operation="DOT_PRODUCT",
            ).value
            / edge_j_den,
            value_001=0.0,
            operation="MAXIMUM",
        ),
        value_001=1.0,
        operation="MINIMUM",
    )
    t_i_end_on_j = math(
        value=math(
            value=vector_math(
                vector=i_end_from_j,
                vector_001=edge_j_vector,
                operation="DOT_PRODUCT",
            ).value
            / edge_j_den,
            value_001=0.0,
            operation="MAXIMUM",
        ),
        value_001=1.0,
        operation="MINIMUM",
    )
    proj_j_start_on_i = vector_math(
        vector=edge_i_start,
        vector_001=vector_math(
            vector=edge_i_vector, scale=t_j_start_on_i, operation="SCALE"
        ),
        operation="ADD",
    )
    proj_j_end_on_i = vector_math(
        vector=edge_i_start,
        vector_001=vector_math(
            vector=edge_i_vector, scale=t_j_end_on_i, operation="SCALE"
        ),
        operation="ADD",
    )
    proj_i_start_on_j = vector_math(
        vector=edge_start,
        vector_001=vector_math(
            vector=edge_j_vector, scale=t_i_start_on_j, operation="SCALE"
        ),
        operation="ADD",
    )
    proj_i_end_on_j = vector_math(
        vector=edge_start,
        vector_001=vector_math(
            vector=edge_j_vector, scale=t_i_end_on_j, operation="SCALE"
        ),
        operation="ADD",
    )
    min_clearance = math(
        value=math(
            value=vector_math(
                vector=edge_start,
                vector_001=proj_j_start_on_i,
                operation="DISTANCE",
            ).value,
            value_001=vector_math(
                vector=edge_end,
                vector_001=proj_j_end_on_i,
                operation="DISTANCE",
            ).value,
            operation="MINIMUM",
        ),
        value_001=math(
            value=vector_math(
                vector=edge_i_start,
                vector_001=proj_i_start_on_j,
                operation="DISTANCE",
            ).value,
            value_001=vector_math(
                vector=edge_i_end,
                vector_001=proj_i_end_on_j,
                operation="DISTANCE",
            ).value,
            operation="MINIMUM",
        ),
        operation="MINIMUM",
    )
    too_close = compare(a=min_clearance, b=weld_distance, operation="LESS_EQUAL")
    edge_pair_bad = boolean_math(
        boolean=check_pair,
        boolean_001=boolean_math(
            boolean=proper_cross, boolean_001=too_close, operation="OR"
        ),
        operation="AND",
    )
    edge_pair_bad_count = attribute_statistic(
        geometry=pair_points_2,
        attribute=switch(
            switch=edge_pair_bad, false=0.0, true=1.0, input_type="FLOAT"
        ),
        data_type="FLOAT", domain="POINT",
    ).sum

    y_a_above = compare(a=edge_a_xyz.y, b=target_xyz.y, operation="GREATER_THAN")
    y_b_above = compare(a=edge_b_xyz.y, b=target_xyz.y, operation="GREATER_THAN")
    y_cross = compare(
        a=switch(switch=y_a_above, false=0, true=1, input_type="INT"),
        b=switch(switch=y_b_above, false=0, true=1, input_type="INT"),
        operation="NOT_EQUAL", data_type="INT",
    )
    dy = edge_b_xyz.y - edge_a_xyz.y
    safe_dy = switch(switch=y_cross, false=1.0, true=dy, input_type="FLOAT")
    hit_x = edge_a_xyz.x + (
        (target_xyz.y - edge_a_xyz.y) * (edge_b_xyz.x - edge_a_xyz.x) / safe_dy
    )
    other_component = compare(
        a=target_ci, b=edge_ci, operation="NOT_EQUAL", data_type="INT"
    )
    crossing = boolean_math(
        boolean=boolean_math(boolean=y_cross, boolean_001=other_component, operation="AND"),
        boolean_001=compare(a=hit_x, b=target_xyz.x, operation="GREATER_THAN"),
        operation="AND",
    )
    containment_group = float_to_int(
        float=pair2_i * m_float + edge_ci * 1.0,
        rounding_mode="ROUND",
    )
    component_crossing_total = accumulate_field(
        value=switch(
            switch=crossing, false=0.0, true=1.0, input_type="FLOAT"
        ),
        group_id=containment_group, data_type="FLOAT", domain="POINT",
    ).total
    anchor_j = sample_index(
        geometry=rows_anchor_k,
        value=input_named_attribute(name="_danchor", data_type="BOOLEAN"),
        index=pair2_j, data_type="BOOLEAN", domain="POINT",
    )
    component_inside = compare(
        a=math(
            value=component_crossing_total,
            value_001=2.0,
            operation="MODULO",
        ),
        b=0.5,
        operation="GREATER_THAN",
    )
    component_depth = boolean_math(
        boolean=anchor_j, boolean_001=component_inside, operation="AND"
    )
    depth_total = accumulate_field(
        value=switch(
            switch=component_depth, false=0.0, true=1.0, input_type="FLOAT"
        ),
        group_id=pair2_i, data_type="FLOAT", domain="POINT",
    ).total
    anchor_i_pos = separate_xyz(vector=target_anchor)
    anchor_j_pos = separate_xyz(
        vector=sample_index(
            geometry=rows_anchor_k,
            value=input_named_attribute(name="_dapos", data_type="FLOAT_VECTOR"),
            index=pair2_j, data_type="FLOAT_VECTOR", domain="POINT",
        )
    )
    anchor_x_equal = boolean_math(
        boolean=boolean_math(
            boolean=compare(a=anchor_i_pos.x, b=anchor_j_pos.x, operation="LESS_THAN"),
            operation="NOT",
        ),
        boolean_001=boolean_math(
            boolean=compare(a=anchor_j_pos.x, b=anchor_i_pos.x, operation="LESS_THAN"),
            operation="NOT",
        ),
        operation="AND",
    )
    anchor_j_before = boolean_math(
        boolean=compare(a=anchor_j_pos.x, b=anchor_i_pos.x, operation="LESS_THAN"),
        boolean_001=boolean_math(
            boolean=anchor_x_equal,
            boolean_001=compare(a=anchor_j_pos.y, b=anchor_i_pos.y, operation="LESS_THAN"),
            operation="AND",
        ),
        operation="OR",
    )
    component_before = boolean_math(
        boolean=anchor_j,
        boolean_001=boolean_math(
            boolean=other_component, boolean_001=anchor_j_before, operation="AND"
        ),
        operation="AND",
    )
    all_rank_total = accumulate_field(
        value=switch(
            switch=component_before, false=0.0, true=1.0,
            input_type="FLOAT",
        ),
        group_id=pair2_i, data_type="FLOAT", domain="POINT",
    ).total
    depth_for_row = sample_index(
        geometry=pair_points_2, value=depth_total, index=row_pair_start,
        data_type="FLOAT", domain="POINT",
    )
    all_rank_for_row = sample_index(
        geometry=pair_points_2, value=all_rank_total, index=row_pair_start,
        data_type="FLOAT", domain="POINT",
    )
    depth_i = float_to_int(float=depth_for_row, rounding_mode="ROUND")
    role0 = compare(a=depth_i, b=0, operation="EQUAL", data_type="INT")
    role = switch(switch=role0, false=1, true=0, input_type="INT")
    outer_anchor = boolean_math(
        boolean=is_anchor, boolean_001=role0, operation="AND"
    )
    outer_count = attribute_statistic(
        geometry=rows_anchor_k,
        attribute=switch(
            switch=outer_anchor, false=0.0, true=1.0, input_type="FLOAT"
        ),
        data_type="FLOAT", domain="POINT",
    ).sum
    outer_x = attribute_statistic(
        geometry=rows_anchor_k, selection=outer_anchor,
        attribute=separate_xyz(vector=input_position()).x,
        data_type="FLOAT", domain="POINT",
    ).min
    outer_y = attribute_statistic(
        geometry=rows_anchor_k, selection=outer_anchor,
        attribute=separate_xyz(vector=input_position()).y,
        data_type="FLOAT", domain="POINT",
    ).min
    target_a = separate_xyz(
        vector=input_named_attribute(name="_dapos", data_type="FLOAT_VECTOR")
    )
    target_before_outer = boolean_math(
        boolean=compare(a=target_a.x, b=outer_x, operation="LESS_THAN"),
        boolean_001=boolean_math(
            boolean=boolean_math(
                boolean=compare(a=target_a.x, b=outer_x, operation="LESS_THAN"),
                operation="NOT",
            ),
            boolean_001=boolean_math(
                boolean=boolean_math(
                    boolean=compare(a=outer_x, b=target_a.x, operation="LESS_THAN"),
                    operation="NOT",
                ),
                boolean_001=compare(a=target_a.y, b=outer_y, operation="LESS_THAN"),
                operation="AND",
            ),
            operation="AND",
        ),
        operation="OR",
    )
    hole_id = float_to_int(
        float=all_rank_for_row + switch(
            switch=target_before_outer, false=0.0, true=1.0,
            input_type="FLOAT",
        ),
        rounding_mode="ROUND",
    )
    contour_id = switch(switch=role0, false=hole_id, true=0, input_type="INT")

    row_k = input_named_attribute(name="_dk", data_type="INT")
    row_n = input_named_attribute(name="_dn", data_type="INT")
    row_anchor_k = input_named_attribute(name="_dak", data_type="INT")
    row_area = input_named_attribute(name="_darea", data_type="FLOAT")
    generated_ccw = compare(a=row_area, b=0.0, operation="GREATER_THAN")
    desired_forward = boolean_math(
        boolean=boolean_math(boolean=role0, boolean_001=generated_ccw, operation="AND"),
        boolean_001=boolean_math(
            boolean=boolean_math(boolean=role0, operation="NOT"),
            boolean_001=boolean_math(boolean=generated_ccw, operation="NOT"),
            operation="AND",
        ),
        operation="OR",
    )
    rank_forward = math(
        value=(row_k - row_anchor_k + row_n) * 1.0,
        value_001=row_n * 1.0, operation="MODULO",
    )
    rank_reverse = math(
        value=(row_anchor_k - row_k + row_n) * 1.0,
        value_001=row_n * 1.0, operation="MODULO",
    )
    local_rank = float_to_int(
        float=switch(
            switch=desired_forward, false=rank_reverse, true=rank_forward,
            input_type="FLOAT",
        ),
        rounding_mode="ROUND",
    )
    rows_role = store_named_attribute(
        geometry=rows_anchor_k, name="role", value=role,
        data_type="INT", domain="POINT",
    )
    rows_contour = store_named_attribute(
        geometry=rows_role, name="contour_id", value=contour_id,
        data_type="INT", domain="POINT",
    )
    rows_rank = store_named_attribute(
        geometry=rows_contour, name="local_rank", value=local_rank,
        data_type="INT", domain="POINT",
    )
    sorted_rows = sort_elements(
        geometry=rows_rank, selection=True, group_id=0,
        sort_weight=contour_id * (m_float + 1.0) + local_rank * 1.0,
        domain="POINT",
    )
    sorted_rank = input_named_attribute(name="local_rank", data_type="INT")
    sorted_count = input_named_attribute(name="_dn", data_type="INT")
    row_ordinal = input_index() * 1.0
    contour_start = row_ordinal - sorted_rank * 1.0
    next_ordinal = contour_start + math(
        value=sorted_rank * 1.0 + 1.0,
        value_001=sorted_count * 1.0, operation="MODULO",
    )
    prev_ordinal = contour_start + math(
        value=sorted_rank * 1.0 + sorted_count * 1.0 - 1.0,
        value_001=sorted_count * 1.0, operation="MODULO",
    )
    with_next = store_named_attribute(
        geometry=sorted_rows, name="n0", value=next_ordinal,
        data_type="FLOAT", domain="POINT",
    )
    with_prev = store_named_attribute(
        geometry=with_next, name="p0", value=prev_ordinal,
        data_type="FLOAT", domain="POINT",
    )
    with_lav = store_named_attribute(
        geometry=with_prev, name="lav0",
        value=input_named_attribute(name="contour_id", data_type="INT") * 1.0,
        data_type="FLOAT", domain="POINT",
    )
    with_edge = store_named_attribute(
        geometry=with_lav, name="ed0", value=row_ordinal,
        data_type="FLOAT", domain="POINT",
    )
    ring = store_named_attribute(
        geometry=with_edge, name="wq1", value=1.0,
        data_type="FLOAT", domain="POINT",
    )

    count_stats = attribute_statistic(
        geometry=rows_anchor_k,
        attribute=input_named_attribute(name="_dn", data_type="INT") * 1.0,
        data_type="FLOAT", domain="POINT",
    )
    area_zero_count = attribute_statistic(
        geometry=rows_anchor_k,
        attribute=switch(
            switch=compare(
                a=math(value=input_named_attribute(name="_darea", data_type="FLOAT"), operation="ABSOLUTE"),
                b=input_named_attribute(name="_darea_floor", data_type="FLOAT"),
                operation="LESS_EQUAL",
            ),
            false=0.0, true=1.0, input_type="FLOAT",
        ),
        data_type="FLOAT", domain="POINT",
    ).sum
    depth_bad_count = attribute_statistic(
        geometry=rows_anchor_k,
        attribute=switch(
            switch=compare(a=depth_i, b=1, operation="GREATER_THAN", data_type="INT"),
            false=0.0, true=1.0, input_type="FLOAT",
        ),
        data_type="FLOAT", domain="POINT",
    ).sum
    shape_bad = boolean_math(
        boolean=boolean_math(
            boolean=compare(a=count_stats.min, b=3.0, operation="LESS_THAN"),
            boolean_001=compare(a=area_zero_count, b=0.0, operation="GREATER_THAN"),
            operation="OR",
        ),
        boolean_001=boolean_math(
            boolean=compare(a=outer_count, b=1.0, operation="NOT_EQUAL"),
            boolean_001=compare(a=depth_bad_count, b=0.0, operation="GREATER_THAN"),
            operation="OR",
        ),
        operation="OR",
    )
    geometry_bad = boolean_math(
        boolean=shape_bad,
        boolean_001=compare(
            a=edge_pair_bad_count, b=0.0, operation="GREATER_THAN"
        ),
        operation="OR",
    )
    c9_bad = boolean_math(
        boolean=cloud_free_bad,
        boolean_001=boolean_math(
            boolean=boolean_math(boolean=c1_bad, operation="NOT"),
            boolean_001=geometry_bad, operation="AND",
        ),
        operation="OR",
    )
    admitted_ring = switch(
        switch=boolean_math(boolean=c9_bad, operation="NOT"),
        false=points(count=0), true=ring, input_type="GEOMETRY",
    )
    return (admitted_ring, m * 1.0, m, c9_bad, c1_bad)


@node_tree(id="opus.gnslice.ring.v1", target="geometry")
def skel_ring(
    outline: Geometry,
    max_split_pairs: Integer = 4096,
    weld_distance: Float = 0.00001,
) -> tuple[Geometry, Float, Geometry, Float, Integer, Boolean, Boolean, Boolean]:
    """Rung-3b canonical mesh carrier with a narrow legacy adapter.

    Canonical identity is authored ``(role, contour_id, local_rank)``. A
    bounded MxM comparison cloud derives a unique lexicographic ordinal; no
    generated index survives as persistent identity. Generated ``_face`` is
    diagnostic only, used to prove one authored contour per input face.
    """
    dims = attribute_domain_size(geometry=outline, component="MESH")
    m = dims.point_count
    face_count = dims.face_count
    corner_count = dims.face_corner_count

    all_names = get_attribute_names(geometry=outline)
    all_region = filter_list(
        list=all_names.names,
        selection=compare(
            a=all_names.names, b="region_id", operation="EQUAL",
            data_type="STRING",
        ),
        socket_type="STRING",
    )
    all_contour = filter_list(
        list=all_names.names,
        selection=compare(
            a=all_names.names, b="contour_id", operation="EQUAL",
            data_type="STRING",
        ),
        socket_type="STRING",
    )
    all_role = filter_list(
        list=all_names.names,
        selection=compare(
            a=all_names.names, b="role", operation="EQUAL",
            data_type="STRING",
        ),
        socket_type="STRING",
    )
    all_rank = filter_list(
        list=all_names.names,
        selection=compare(
            a=all_names.names, b="local_rank", operation="EQUAL",
            data_type="STRING",
        ),
        socket_type="STRING",
    )
    all_w = filter_list(
        list=all_names.names,
        selection=compare(
            a=all_names.names, b="w", operation="EQUAL",
            data_type="STRING",
        ),
        socket_type="STRING",
    )
    all_gable = filter_list(
        list=all_names.names,
        selection=compare(
            a=all_names.names, b="gable", operation="EQUAL",
            data_type="STRING",
        ),
        socket_type="STRING",
    )
    n_region = list_length(list=all_region.selection, data_type="STRING").length
    n_contour = list_length(list=all_contour.selection, data_type="STRING").length
    n_role = list_length(list=all_role.selection, data_type="STRING").length
    n_rank = list_length(list=all_rank.selection, data_type="STRING").length
    n_w = list_length(list=all_w.selection, data_type="STRING").length
    n_gable = list_length(list=all_gable.selection, data_type="STRING").length
    marker_any = boolean_math(
        boolean=boolean_math(
            boolean=compare(a=n_region, b=0, operation="GREATER_THAN", data_type="INT"),
            boolean_001=compare(a=n_contour, b=0, operation="GREATER_THAN", data_type="INT"),
            operation="OR",
        ),
        boolean_001=boolean_math(
            boolean=compare(a=n_role, b=0, operation="GREATER_THAN", data_type="INT"),
            boolean_001=compare(a=n_rank, b=0, operation="GREATER_THAN", data_type="INT"),
            operation="OR",
        ),
        operation="OR",
    )

    region_names = get_attribute_names(
        geometry=outline, filter_data_type=True, data_type="Integer",
        filter_domain=True, domain="Face",
    )
    corner_int_names = get_attribute_names(
        geometry=outline, filter_data_type=True, data_type="Integer",
        filter_domain=True, domain="Face Corner",
    )
    point_int_names = get_attribute_names(
        geometry=outline, filter_data_type=True, data_type="Integer",
        filter_domain=True, domain="Point",
    )
    corner_float_names = get_attribute_names(
        geometry=outline, filter_data_type=True, data_type="Float",
        filter_domain=True, domain="Face Corner",
    )
    region_exact = compare(
        a=list_length(
            list=filter_list(
                list=region_names.names,
                selection=compare(
                    a=region_names.names, b="region_id", operation="EQUAL",
                    data_type="STRING",
                ),
                socket_type="STRING",
            ).selection,
            data_type="STRING",
        ).length,
        b=1, operation="EQUAL", data_type="INT",
    )
    contour_exact = compare(
        a=list_length(
            list=filter_list(
                list=corner_int_names.names,
                selection=compare(
                    a=corner_int_names.names, b="contour_id", operation="EQUAL",
                    data_type="STRING",
                ),
                socket_type="STRING",
            ).selection,
            data_type="STRING",
        ).length,
        b=1, operation="EQUAL", data_type="INT",
    )
    role_exact = compare(
        a=list_length(
            list=filter_list(
                list=corner_int_names.names,
                selection=compare(
                    a=corner_int_names.names, b="role", operation="EQUAL",
                    data_type="STRING",
                ),
                socket_type="STRING",
            ).selection,
            data_type="STRING",
        ).length,
        b=1, operation="EQUAL", data_type="INT",
    )
    rank_exact = compare(
        a=list_length(
            list=filter_list(
                list=corner_int_names.names,
                selection=compare(
                    a=corner_int_names.names, b="local_rank", operation="EQUAL",
                    data_type="STRING",
                ),
                socket_type="STRING",
            ).selection,
            data_type="STRING",
        ).length,
        b=1, operation="EQUAL", data_type="INT",
    )
    w_exact = compare(
        a=list_length(
            list=filter_list(
                list=corner_float_names.names,
                selection=compare(
                    a=corner_float_names.names, b="w", operation="EQUAL",
                    data_type="STRING",
                ),
                socket_type="STRING",
            ).selection,
            data_type="STRING",
        ).length,
        b=1, operation="EQUAL", data_type="INT",
    )
    gable_corner_exact = compare(
        a=list_length(
            list=filter_list(
                list=corner_int_names.names,
                selection=compare(
                    a=corner_int_names.names, b="gable", operation="EQUAL",
                    data_type="STRING",
                ),
                socket_type="STRING",
            ).selection,
            data_type="STRING",
        ).length,
        b=1, operation="EQUAL", data_type="INT",
    )
    gable_point_exact = compare(
        a=list_length(
            list=filter_list(
                list=point_int_names.names,
                selection=compare(
                    a=point_int_names.names, b="gable", operation="EQUAL",
                    data_type="STRING",
                ),
                socket_type="STRING",
            ).selection,
            data_type="STRING",
        ).length,
        b=1, operation="EQUAL", data_type="INT",
    )
    exact_domains = boolean_math(
        boolean=boolean_math(
            boolean=region_exact, boolean_001=contour_exact, operation="AND"
        ),
        boolean_001=boolean_math(
            boolean=boolean_math(
                boolean=role_exact, boolean_001=rank_exact, operation="AND"
            ),
            boolean_001=w_exact,
            operation="AND",
        ),
        operation="AND",
    )
    exact_totals = boolean_math(
        boolean=boolean_math(
            boolean=compare(a=n_region, b=1, operation="EQUAL", data_type="INT"),
            boolean_001=compare(a=n_contour, b=1, operation="EQUAL", data_type="INT"),
            operation="AND",
        ),
        boolean_001=boolean_math(
            boolean=boolean_math(
                boolean=compare(a=n_role, b=1, operation="EQUAL", data_type="INT"),
                boolean_001=compare(a=n_rank, b=1, operation="EQUAL", data_type="INT"),
                operation="AND",
            ),
            boolean_001=compare(a=n_w, b=1, operation="EQUAL", data_type="INT"),
            operation="AND",
        ),
        operation="AND",
    )
    canonical = boolean_math(
        boolean=exact_domains, boolean_001=exact_totals, operation="AND"
    )
    base_schema_bad = boolean_math(
        boolean=marker_any,
        boolean_001=boolean_math(boolean=canonical, operation="NOT"),
        operation="AND",
    )
    gable_present = compare(
        a=n_gable, b=0, operation="GREATER_THAN", data_type="INT"
    )
    gable_expected_exact = switch(
        switch=marker_any,
        false=gable_point_exact,
        true=gable_corner_exact,
        input_type="BOOLEAN",
    )
    gable_schema_bad = boolean_math(
        boolean=gable_present,
        boolean_001=boolean_math(boolean=gable_expected_exact, operation="NOT"),
        operation="AND",
    )
    schema_bad = boolean_math(
        boolean=base_schema_bad, boolean_001=gable_schema_bad, operation="OR"
    )

    markerless = boolean_math(boolean=marker_any, operation="NOT")
    face_ge_two = compare(
        a=face_count, b=2, operation="GREATER_EQUAL", data_type="INT"
    )
    derived_sel = boolean_math(
        boolean=markerless, boolean_001=face_ge_two, operation="AND"
    )
    derived_w_bad = boolean_math(
        boolean=derived_sel,
        boolean_001=compare(a=n_w, b=0, operation="GREATER_THAN", data_type="INT"),
        operation="AND",
    )
    derived_gable_bad = boolean_math(
        boolean=derived_sel, boolean_001=gable_present, operation="AND"
    )
    derived_carrier_bad = boolean_math(
        boolean=derived_w_bad, boolean_001=derived_gable_bad, operation="OR"
    )
    derived_enabled = boolean_math(
        boolean=derived_sel,
        boolean_001=boolean_math(boolean=derived_carrier_bad, operation="NOT"),
        operation="AND",
    )
    derived_input = switch(
        switch=derived_enabled, false=points(count=0), true=outline,
        input_type="GEOMETRY",
    )
    derived_ring, derived_nf, derived_n, derived_topology_bad, derived_c1_bad = (
        skel_ring_derived(
            outline=derived_input,
            max_split_pairs=max_split_pairs,
            weld_distance=weld_distance,
        )
    )
    legacy_sel = boolean_math(
        boolean=markerless,
        boolean_001=compare(a=face_count, b=1, operation="EQUAL", data_type="INT"),
        operation="AND",
    )
    authored_input = switch(
        switch=canonical, false=points(count=0), true=outline,
        input_type="GEOMETRY",
    )
    legacy_input = switch(
        switch=legacy_sel, false=points(count=0), true=outline,
        input_type="GEOMETRY",
    )

    face_curves = mesh_to_curve(mesh=authored_input, selection=True, mode="FACES")
    curve_lookup = curve_of_point(point_index=input_index())
    face_tagged = store_named_attribute(
        geometry=face_curves, name="_face", value=curve_lookup.curve_index,
        data_type="INT", domain="POINT",
    )
    rows = curve_to_mesh(curve=face_tagged, profile_curve=None)
    row_count = attribute_domain_size(
        geometry=rows, component="MESH"
    ).point_count

    raw_pair_count = math(
        value=row_count * 1.0, value_001=row_count * 1.0,
        operation="MULTIPLY",
    )
    pair_limit = max_split_pairs * 1.0
    authored_c1_bad = compare(a=raw_pair_count, b=pair_limit, operation="GREATER_THAN")
    pair_count = float_to_int(
        float=math(value=raw_pair_count, value_001=pair_limit, operation="MINIMUM"),
        rounding_mode="ROUND",
    )
    pair_points = points(count=pair_count)
    pair_index = input_index() * 1.0
    m_float = row_count * 1.0
    i_float = math(
        value=math(value=pair_index, value_001=m_float, operation="DIVIDE"),
        operation="FLOOR",
    )
    j_float = math(value=pair_index, value_001=m_float, operation="MODULO")
    i_index = float_to_int(float=i_float, rounding_mode="ROUND")
    j_index = float_to_int(float=j_float, rounding_mode="ROUND")

    row_contour = input_named_attribute(name="contour_id", data_type="INT")
    row_role = input_named_attribute(name="role", data_type="INT")
    row_rank = input_named_attribute(name="local_rank", data_type="INT")
    row_weight = input_named_attribute(name="w", data_type="FLOAT")
    row_gable = input_named_attribute(name="gable", data_type="INT")
    row_face = input_named_attribute(name="_face", data_type="INT")
    row_region = input_named_attribute(name="region_id", data_type="INT")
    pos_i = sample_index(
        geometry=rows, value=input_position(), index=i_index,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    contour_i = sample_index(
        geometry=rows, value=row_contour, index=i_index,
        data_type="INT", domain="POINT",
    )
    contour_j = sample_index(
        geometry=rows, value=row_contour, index=j_index,
        data_type="INT", domain="POINT",
    )
    role_i = sample_index(
        geometry=rows, value=row_role, index=i_index,
        data_type="INT", domain="POINT",
    )
    role_j = sample_index(
        geometry=rows, value=row_role, index=j_index,
        data_type="INT", domain="POINT",
    )
    rank_i = sample_index(
        geometry=rows, value=row_rank, index=i_index,
        data_type="INT", domain="POINT",
    )
    rank_j = sample_index(
        geometry=rows, value=row_rank, index=j_index,
        data_type="INT", domain="POINT",
    )
    weight_i = sample_index(
        geometry=rows, value=row_weight, index=i_index,
        data_type="FLOAT", domain="POINT",
    )
    gable_i = sample_index(
        geometry=rows, value=row_gable, index=i_index,
        data_type="INT", domain="POINT",
    )
    face_i = sample_index(
        geometry=rows, value=row_face, index=i_index,
        data_type="INT", domain="POINT",
    )
    face_j = sample_index(
        geometry=rows, value=row_face, index=j_index,
        data_type="INT", domain="POINT",
    )
    region_i = sample_index(
        geometry=rows, value=row_region, index=i_index,
        data_type="INT", domain="POINT",
    )

    role_lt = compare(a=role_j, b=role_i, operation="LESS_THAN", data_type="INT")
    role_eq = compare(a=role_j, b=role_i, operation="EQUAL", data_type="INT")
    contour_lt = compare(
        a=contour_j, b=contour_i, operation="LESS_THAN", data_type="INT"
    )
    contour_eq = compare(
        a=contour_j, b=contour_i, operation="EQUAL", data_type="INT"
    )
    rank_lt = compare(a=rank_j, b=rank_i, operation="LESS_THAN", data_type="INT")
    semantic_less = boolean_math(
        boolean=role_lt,
        boolean_001=boolean_math(
            boolean=role_eq,
            boolean_001=boolean_math(
                boolean=contour_lt,
                boolean_001=boolean_math(
                    boolean=contour_eq, boolean_001=rank_lt, operation="AND"
                ),
                operation="OR",
            ),
            operation="AND",
        ),
        operation="OR",
    )
    same_contour = boolean_math(
        boolean=role_eq, boolean_001=contour_eq, operation="AND"
    )
    rank0_j = compare(a=rank_j, b=0, operation="EQUAL", data_type="INT")
    contour_less = boolean_math(
        boolean=rank0_j,
        boolean_001=boolean_math(
            boolean=role_lt,
            boolean_001=boolean_math(
                boolean=role_eq, boolean_001=contour_lt, operation="AND"
            ),
            operation="OR",
        ),
        operation="AND",
    )
    ordinal = accumulate_field(
        value=switch(
            switch=semantic_less, false=0, true=1, input_type="INT"
        ),
        group_id=i_index, data_type="INT", domain="POINT",
    ).total
    lav_ordinal = accumulate_field(
        value=switch(
            switch=contour_less, false=0, true=1, input_type="INT"
        ),
        group_id=i_index, data_type="INT", domain="POINT",
    ).total
    contour_size = accumulate_field(
        value=switch(
            switch=same_contour, false=0, true=1, input_type="INT"
        ),
        group_id=i_index, data_type="INT", domain="POINT",
    ).total

    pair_pos = set_position(geometry=pair_points, position=pos_i)
    pair_i_row = store_named_attribute(
        geometry=pair_pos, name="_pair_i", value=i_index,
        data_type="INT", domain="POINT",
    )
    pair_j_row = store_named_attribute(
        geometry=pair_i_row, name="_pair_j", value=j_index,
        data_type="INT", domain="POINT",
    )
    pair_ord = store_named_attribute(
        geometry=pair_j_row, name="_ord", value=ordinal,
        data_type="INT", domain="POINT",
    )
    pair_lav = store_named_attribute(
        geometry=pair_ord, name="_lav0", value=lav_ordinal,
        data_type="INT", domain="POINT",
    )
    pair_counted = store_named_attribute(
        geometry=pair_lav, name="_cnt", value=contour_size,
        data_type="INT", domain="POINT",
    )
    pair_contour = store_named_attribute(
        geometry=pair_counted, name="contour_id", value=contour_i,
        data_type="INT", domain="POINT",
    )
    pair_role = store_named_attribute(
        geometry=pair_contour, name="role", value=role_i,
        data_type="INT", domain="POINT",
    )
    pair_rank = store_named_attribute(
        geometry=pair_role, name="local_rank", value=rank_i,
        data_type="INT", domain="POINT",
    )
    pair_weight = store_named_attribute(
        geometry=pair_rank, name="wq1", value=weight_i,
        data_type="FLOAT", domain="POINT",
    )
    pair_gable = store_named_attribute(
        geometry=pair_weight, name="g0", value=gable_i,
        data_type="INT", domain="POINT",
    )
    pair_semantic = store_named_attribute(
        geometry=pair_gable, name="_face", value=face_i,
        data_type="INT", domain="POINT",
    )
    pair_region = store_named_attribute(
        geometry=pair_semantic, name="region_id", value=region_i,
        data_type="INT", domain="POINT",
    )
    pair_i = input_named_attribute(name="_pair_i", data_type="INT")
    pair_j = input_named_attribute(name="_pair_j", data_type="INT")
    representative = compare(
        a=j_index, b=0, operation="EQUAL", data_type="INT"
    )
    reps = delete_geometry(
        geometry=pair_region,
        selection=boolean_math(boolean=representative, operation="NOT"),
        mode="ALL", domain="POINT",
    )
    canonical_rows = sort_elements(
        geometry=reps, selection=True, group_id=0,
        sort_weight=input_named_attribute(name="_ord", data_type="INT"),
        domain="POINT",
    )
    # Sort Elements establishes the canonical row order.  From this point to
    # canonical_ring no operation changes point count or order, so the current
    # post-sort index is the stable authored-slot ordinal.  Keep it as a field
    # instead of round-tripping through a named attribute: a downstream Store
    # value evaluates on that store's input geometry and must not depend on an
    # attribute created by an earlier Store in the same chain.
    canonical_index = input_index() * 1.0
    canonical_rank = input_named_attribute(name="local_rank", data_type="INT") * 1.0
    canonical_count = input_named_attribute(name="_cnt", data_type="INT") * 1.0
    contour_start = math(
        value=canonical_index, value_001=canonical_rank, operation="SUBTRACT"
    )
    next0 = math(
        value=contour_start,
        value_001=math(
            value=math(value=canonical_rank, value_001=1.0, operation="ADD"),
            value_001=canonical_count,
            operation="MODULO",
        ),
        operation="ADD",
    )
    prev0 = math(
        value=contour_start,
        value_001=math(
            value=math(
                value=math(
                    value=canonical_rank, value_001=canonical_count,
                    operation="ADD",
                ),
                value_001=1.0, operation="SUBTRACT",
            ),
            value_001=canonical_count,
            operation="MODULO",
        ),
        operation="ADD",
    )
    ring_nx = store_named_attribute(
        geometry=canonical_rows, name="n0", value=next0,
        data_type="FLOAT", domain="POINT",
    )
    ring_pv = store_named_attribute(
        geometry=ring_nx, name="p0", value=prev0,
        data_type="FLOAT", domain="POINT",
    )
    ring_lav = store_named_attribute(
        geometry=ring_pv, name="lav0",
        value=input_named_attribute(name="_lav0", data_type="INT") * 1.0,
        data_type="FLOAT", domain="POINT",
    )
    canonical_ring = store_named_attribute(
        geometry=ring_lav, name="ed0", value=canonical_index,
        data_type="FLOAT", domain="POINT",
    )

    # Semantic carrier checks. Generated face tokens are used only to prove
    # the one-face/one-authored-contour relationship; authored tuples remain
    # the identity source.
    i_before_j = compare(
        a=pair_i, b=pair_j, operation="LESS_THAN", data_type="INT"
    )
    rank_eq = compare(a=rank_i, b=rank_j, operation="EQUAL", data_type="INT")
    face_eq = compare(a=face_i, b=face_j, operation="EQUAL", data_type="INT")
    same_semantic = boolean_math(
        boolean=same_contour, boolean_001=rank_eq, operation="AND"
    )
    duplicate_semantic = boolean_math(
        boolean=i_before_j, boolean_001=same_semantic, operation="AND"
    )
    face_semantic_mismatch = boolean_math(
        boolean=i_before_j,
        boolean_001=boolean_math(
            boolean=boolean_math(
                boolean=face_eq,
                boolean_001=boolean_math(boolean=same_contour, operation="NOT"),
                operation="AND",
            ),
            boolean_001=boolean_math(
                boolean=same_contour,
                boolean_001=boolean_math(boolean=face_eq, operation="NOT"),
                operation="AND",
            ),
            operation="OR",
        ),
        operation="AND",
    )
    pair_semantic_bad = attribute_statistic(
        geometry=pair_region,
        attribute=switch(
            switch=boolean_math(
                boolean=duplicate_semantic,
                boolean_001=face_semantic_mismatch,
                operation="OR",
            ),
            false=0.0, true=1.0, input_type="FLOAT",
        ),
        data_type="FLOAT", domain="POINT",
    ).max

    ring_role = input_named_attribute(name="role", data_type="INT")
    ring_rank = input_named_attribute(name="local_rank", data_type="INT")
    ring_count = input_named_attribute(name="_cnt", data_type="INT")
    ring_lav_id = input_named_attribute(name="_lav0", data_type="INT")
    ring_region = input_named_attribute(name="region_id", data_type="INT")
    ring_next = input_named_attribute(name="n0", data_type="FLOAT")
    role_bad = boolean_math(
        boolean=compare(a=ring_role, b=0, operation="LESS_THAN", data_type="INT"),
        boolean_001=compare(a=ring_role, b=1, operation="GREATER_THAN", data_type="INT"),
        operation="OR",
    )
    rank_bad = boolean_math(
        boolean=compare(a=ring_rank, b=0, operation="LESS_THAN", data_type="INT"),
        boolean_001=compare(
            a=ring_rank, b=ring_count, operation="GREATER_EQUAL", data_type="INT"
        ),
        operation="OR",
    )
    count_bad = compare(a=ring_count, b=3, operation="LESS_THAN", data_type="INT")
    rank0 = compare(a=ring_rank, b=0, operation="EQUAL", data_type="INT")
    role0 = compare(a=ring_role, b=0, operation="EQUAL", data_type="INT")
    outer_start = boolean_math(boolean=rank0, boolean_001=role0, operation="AND")
    contour_start_count = attribute_statistic(
        geometry=canonical_ring,
        attribute=switch(
            switch=rank0, false=0.0, true=1.0, input_type="FLOAT"
        ),
        data_type="FLOAT", domain="POINT",
    ).sum
    outer_start_count = attribute_statistic(
        geometry=canonical_ring,
        attribute=switch(
            switch=outer_start, false=0.0, true=1.0, input_type="FLOAT"
        ),
        data_type="FLOAT", domain="POINT",
    ).sum
    region_stats = attribute_statistic(
        geometry=canonical_ring, attribute=ring_region * 1.0,
        data_type="FLOAT", domain="POINT",
    )
    # Attribute Statistic guarantees min <= max.  Express inequality with
    # GREATER_THAN so this exact integer-valued check does not inherit the
    # Compare node's implicit 0.001 Epsilon socket.
    region_bad = compare(
        a=region_stats.max, b=region_stats.min, operation="GREATER_THAN"
    )

    ring_xyz = separate_xyz(vector=input_position())
    finite_x = compare(
        a=ring_xyz.x - ring_xyz.x, b=0.0, operation="EQUAL"
    )
    finite_y = compare(
        a=ring_xyz.y - ring_xyz.y, b=0.0, operation="EQUAL"
    )
    finite_z = compare(
        a=ring_xyz.z - ring_xyz.z, b=0.0, operation="EQUAL"
    )
    finite_xy = boolean_math(boolean=finite_x, boolean_001=finite_y, operation="AND")
    finite_xyz = boolean_math(boolean=finite_xy, boolean_001=finite_z, operation="AND")
    planar = compare(
        a=math(value=ring_xyz.z, operation="ABSOLUTE"),
        b=weld_distance, operation="LESS_EQUAL",
    )
    point_bad = boolean_math(
        boolean=boolean_math(boolean=finite_xyz, operation="NOT"),
        boolean_001=boolean_math(boolean=planar, operation="NOT"),
        operation="OR",
    )
    next_index = float_to_int(float=ring_next, rounding_mode="ROUND")
    next_position = sample_index(
        geometry=canonical_ring, value=input_position(), index=next_index,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    edge_vector = vector_math(
        vector=next_position, vector_001=input_position(), operation="SUBTRACT"
    )
    edge_length = vector_math(vector=edge_vector, operation="LENGTH").value
    edge_bad = compare(a=edge_length, b=weld_distance, operation="LESS_EQUAL")
    next_xyz = separate_xyz(vector=next_position)
    area_term = ring_xyz.x * next_xyz.y - next_xyz.x * ring_xyz.y
    area_total = accumulate_field(
        value=area_term, group_id=ring_lav_id,
        data_type="FLOAT", domain="POINT",
    ).total
    wrong_outer_winding = boolean_math(
        boolean=role0,
        boolean_001=compare(a=area_total, b=0.0, operation="LESS_EQUAL"),
        operation="AND",
    )
    wrong_hole_winding = boolean_math(
        boolean=compare(a=ring_role, b=1, operation="EQUAL", data_type="INT"),
        boolean_001=compare(a=area_total, b=0.0, operation="GREATER_EQUAL"),
        operation="AND",
    )
    ring_row_bad = boolean_math(
        boolean=boolean_math(
            boolean=boolean_math(boolean=role_bad, boolean_001=rank_bad, operation="OR"),
            boolean_001=boolean_math(boolean=count_bad, boolean_001=point_bad, operation="OR"),
            operation="OR",
        ),
        boolean_001=boolean_math(
            boolean=edge_bad,
            boolean_001=boolean_math(
                boolean=wrong_outer_winding,
                boolean_001=wrong_hole_winding,
                operation="OR",
            ),
            operation="OR",
        ),
        operation="OR",
    )
    ring_bad_any = attribute_statistic(
        geometry=canonical_ring,
        attribute=switch(
            switch=ring_row_bad, false=0.0, true=1.0, input_type="FLOAT"
        ),
        data_type="FLOAT", domain="POINT",
    ).max

    # Edge-pair geometry on the canonical ring: proper crossings and any
    # non-adjacent clearance at or below weld_distance are invalid.
    edge_a = sample_index(
        geometry=canonical_ring, value=input_position(), index=pair_i,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    edge_c = sample_index(
        geometry=canonical_ring, value=input_position(), index=pair_j,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    next_i = float_to_int(
        float=sample_index(
            geometry=canonical_ring, value=ring_next, index=pair_i,
            data_type="FLOAT", domain="POINT",
        ),
        rounding_mode="ROUND",
    )
    next_j = float_to_int(
        float=sample_index(
            geometry=canonical_ring, value=ring_next, index=pair_j,
            data_type="FLOAT", domain="POINT",
        ),
        rounding_mode="ROUND",
    )
    edge_b = sample_index(
        geometry=canonical_ring, value=input_position(), index=next_i,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    edge_d = sample_index(
        geometry=canonical_ring, value=input_position(), index=next_j,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    lav_i = sample_index(
        geometry=canonical_ring, value=ring_lav_id, index=pair_i,
        data_type="INT", domain="POINT",
    )
    lav_j = sample_index(
        geometry=canonical_ring, value=ring_lav_id, index=pair_j,
        data_type="INT", domain="POINT",
    )
    canonical_role_i = sample_index(
        geometry=canonical_ring, value=ring_role, index=pair_i,
        data_type="INT", domain="POINT",
    )
    canonical_role_j = sample_index(
        geometry=canonical_ring, value=ring_role, index=pair_j,
        data_type="INT", domain="POINT",
    )
    canonical_rank_i = sample_index(
        geometry=canonical_ring, value=ring_rank, index=pair_i,
        data_type="INT", domain="POINT",
    )
    canonical_rank_j = sample_index(
        geometry=canonical_ring, value=ring_rank, index=pair_j,
        data_type="INT", domain="POINT",
    )
    same_lav = compare(a=lav_i, b=lav_j, operation="EQUAL", data_type="INT")
    adjacent = boolean_math(
        boolean=compare(a=next_i, b=pair_j, operation="EQUAL", data_type="INT"),
        boolean_001=compare(a=next_j, b=pair_i, operation="EQUAL", data_type="INT"),
        operation="OR",
    )
    allowed_pair = boolean_math(
        boolean=same_lav, boolean_001=adjacent, operation="AND"
    )
    check_pair = boolean_math(
        boolean=i_before_j,
        boolean_001=boolean_math(boolean=allowed_pair, operation="NOT"),
        operation="AND",
    )

    ab = vector_math(vector=edge_b, vector_001=edge_a, operation="SUBTRACT")
    cd = vector_math(vector=edge_d, vector_001=edge_c, operation="SUBTRACT")
    ac = vector_math(vector=edge_c, vector_001=edge_a, operation="SUBTRACT")
    ad = vector_math(vector=edge_d, vector_001=edge_a, operation="SUBTRACT")
    ca = vector_math(vector=edge_a, vector_001=edge_c, operation="SUBTRACT")
    cb = vector_math(vector=edge_b, vector_001=edge_c, operation="SUBTRACT")
    o1 = separate_xyz(
        vector=vector_math(vector=ab, vector_001=ac, operation="CROSS_PRODUCT")
    ).z
    o2 = separate_xyz(
        vector=vector_math(vector=ab, vector_001=ad, operation="CROSS_PRODUCT")
    ).z
    o3 = separate_xyz(
        vector=vector_math(vector=cd, vector_001=ca, operation="CROSS_PRODUCT")
    ).z
    o4 = separate_xyz(
        vector=vector_math(vector=cd, vector_001=cb, operation="CROSS_PRODUCT")
    ).z
    ab_length = vector_math(vector=ab, operation="LENGTH").value
    cd_length = vector_math(vector=cd, operation="LENGTH").value
    area_epsilon = weld_distance * math(
        value=math(value=ab_length, value_001=cd_length, operation="MAXIMUM"),
        value_001=1.0, operation="MAXIMUM",
    )
    neg_area_epsilon = area_epsilon * -1.0
    o12_opposite = boolean_math(
        boolean=boolean_math(
            boolean=compare(a=o1, b=area_epsilon, operation="GREATER_THAN"),
            boolean_001=compare(a=neg_area_epsilon, b=o2, operation="GREATER_THAN"),
            operation="AND",
        ),
        boolean_001=boolean_math(
            boolean=compare(a=o2, b=area_epsilon, operation="GREATER_THAN"),
            boolean_001=compare(a=neg_area_epsilon, b=o1, operation="GREATER_THAN"),
            operation="AND",
        ),
        operation="OR",
    )
    o34_opposite = boolean_math(
        boolean=boolean_math(
            boolean=compare(a=o3, b=area_epsilon, operation="GREATER_THAN"),
            boolean_001=compare(a=neg_area_epsilon, b=o4, operation="GREATER_THAN"),
            operation="AND",
        ),
        boolean_001=boolean_math(
            boolean=compare(a=o4, b=area_epsilon, operation="GREATER_THAN"),
            boolean_001=compare(a=neg_area_epsilon, b=o3, operation="GREATER_THAN"),
            operation="AND",
        ),
        operation="OR",
    )
    proper_cross = boolean_math(
        boolean=o12_opposite, boolean_001=o34_opposite, operation="AND"
    )

    ab_den = math(
        value=vector_math(vector=ab, vector_001=ab, operation="DOT_PRODUCT").value,
        value_001=1e-20, operation="MAXIMUM",
    )
    cd_den = math(
        value=vector_math(vector=cd, vector_001=cd, operation="DOT_PRODUCT").value,
        value_001=1e-20, operation="MAXIMUM",
    )
    t_c_ab = math(
        value=math(
            value=vector_math(vector=ac, vector_001=ab, operation="DOT_PRODUCT").value / ab_den,
            value_001=0.0, operation="MAXIMUM",
        ),
        value_001=1.0, operation="MINIMUM",
    )
    t_d_ab = math(
        value=math(
            value=vector_math(vector=ad, vector_001=ab, operation="DOT_PRODUCT").value / ab_den,
            value_001=0.0, operation="MAXIMUM",
        ),
        value_001=1.0, operation="MINIMUM",
    )
    t_a_cd = math(
        value=math(
            value=vector_math(vector=ca, vector_001=cd, operation="DOT_PRODUCT").value / cd_den,
            value_001=0.0, operation="MAXIMUM",
        ),
        value_001=1.0, operation="MINIMUM",
    )
    t_b_cd = math(
        value=math(
            value=vector_math(vector=cb, vector_001=cd, operation="DOT_PRODUCT").value / cd_den,
            value_001=0.0, operation="MAXIMUM",
        ),
        value_001=1.0, operation="MINIMUM",
    )
    proj_c_ab = vector_math(
        vector=edge_a,
        vector_001=vector_math(vector=ab, scale=t_c_ab, operation="SCALE"),
        operation="ADD",
    )
    proj_d_ab = vector_math(
        vector=edge_a,
        vector_001=vector_math(vector=ab, scale=t_d_ab, operation="SCALE"),
        operation="ADD",
    )
    proj_a_cd = vector_math(
        vector=edge_c,
        vector_001=vector_math(vector=cd, scale=t_a_cd, operation="SCALE"),
        operation="ADD",
    )
    proj_b_cd = vector_math(
        vector=edge_c,
        vector_001=vector_math(vector=cd, scale=t_b_cd, operation="SCALE"),
        operation="ADD",
    )
    min_clearance = math(
        value=math(
            value=vector_math(vector=edge_c, vector_001=proj_c_ab, operation="DISTANCE").value,
            value_001=vector_math(vector=edge_d, vector_001=proj_d_ab, operation="DISTANCE").value,
            operation="MINIMUM",
        ),
        value_001=math(
            value=vector_math(vector=edge_a, vector_001=proj_a_cd, operation="DISTANCE").value,
            value_001=vector_math(vector=edge_b, vector_001=proj_b_cd, operation="DISTANCE").value,
            operation="MINIMUM",
        ),
        operation="MINIMUM",
    )
    too_close = compare(a=min_clearance, b=weld_distance, operation="LESS_EQUAL")
    edge_pair_bad = boolean_math(
        boolean=check_pair,
        boolean_001=boolean_math(
            boolean=proper_cross, boolean_001=too_close, operation="OR"
        ),
        operation="AND",
    )
    edge_pair_bad_any = attribute_statistic(
        geometry=pair_region,
        attribute=switch(
            switch=edge_pair_bad, false=0.0, true=1.0, input_type="FLOAT"
        ),
        data_type="FLOAT", domain="POINT",
    ).max

    # Per-hole point-in-contour parity. Grouping by target row and candidate
    # lav keeps nested-hole detection correct even with multiple holes.
    a_xy = separate_xyz(vector=edge_a)
    c_xy = separate_xyz(vector=edge_c)
    d_xy = separate_xyz(vector=edge_d)
    c_above = compare(a=c_xy.y, b=a_xy.y, operation="GREATER_THAN")
    d_above = compare(a=d_xy.y, b=a_xy.y, operation="GREATER_THAN")
    crosses_y = boolean_math(
        boolean=boolean_math(boolean=c_above, boolean_001=d_above, operation="OR"),
        boolean_001=boolean_math(
            boolean=boolean_math(boolean=c_above, boolean_001=d_above, operation="AND"),
            operation="NOT",
        ),
        operation="AND",
    )
    ray_dy = d_xy.y - c_xy.y
    safe_ray_dy = switch(
        switch=crosses_y, false=1.0, true=ray_dy, input_type="FLOAT"
    )
    ray_x = c_xy.x + (a_xy.y - c_xy.y) * (d_xy.x - c_xy.x) / safe_ray_dy
    ray_hit = boolean_math(
        boolean=crosses_y,
        boolean_001=compare(a=ray_x, b=a_xy.x, operation="GREATER_THAN"),
        operation="AND",
    )
    containment_group = float_to_int(
        float=pair_i * row_count + lav_j,
        rounding_mode="ROUND",
    )
    ray_total = accumulate_field(
        value=switch(switch=ray_hit, false=0, true=1, input_type="INT"),
        group_id=containment_group, data_type="INT", domain="POINT",
    ).total
    inside_candidate = compare(
        a=math(value=ray_total * 1.0, value_001=2.0, operation="MODULO"),
        b=0.5, operation="GREATER_THAN",
    )
    target_hole_start = boolean_math(
        boolean=compare(
            a=canonical_role_i, b=1, operation="EQUAL", data_type="INT"
        ),
        boolean_001=compare(
            a=canonical_rank_i, b=0, operation="EQUAL", data_type="INT"
        ),
        operation="AND",
    )
    candidate_start = compare(
        a=canonical_rank_j, b=0, operation="EQUAL", data_type="INT"
    )
    candidate_outer = compare(
        a=canonical_role_j, b=0, operation="EQUAL", data_type="INT"
    )
    candidate_other_hole = boolean_math(
        boolean=compare(
            a=canonical_role_j, b=1, operation="EQUAL", data_type="INT"
        ),
        boolean_001=compare(
            a=lav_i, b=lav_j, operation="NOT_EQUAL", data_type="INT"
        ),
        operation="AND",
    )
    hole_outside = boolean_math(
        boolean=boolean_math(
            boolean=target_hole_start, boolean_001=candidate_start, operation="AND"
        ),
        boolean_001=boolean_math(
            boolean=candidate_outer,
            boolean_001=boolean_math(boolean=inside_candidate, operation="NOT"),
            operation="AND",
        ),
        operation="AND",
    )
    nested_hole = boolean_math(
        boolean=boolean_math(
            boolean=target_hole_start, boolean_001=candidate_start, operation="AND"
        ),
        boolean_001=boolean_math(
            boolean=candidate_other_hole,
            boolean_001=inside_candidate,
            operation="AND",
        ),
        operation="AND",
    )
    containment_bad_any = attribute_statistic(
        geometry=pair_region,
        attribute=switch(
            switch=boolean_math(
                boolean=hole_outside, boolean_001=nested_hole, operation="OR"
            ),
            false=0.0, true=1.0, input_type="FLOAT",
        ),
        data_type="FLOAT", domain="POINT",
    ).max

    scalar_semantic_bad = boolean_math(
        boolean=boolean_math(
            boolean=compare(a=pair_semantic_bad, b=0.5, operation="GREATER_THAN"),
            boolean_001=compare(a=ring_bad_any, b=0.5, operation="GREATER_THAN"),
            operation="OR",
        ),
        boolean_001=boolean_math(
            boolean=region_bad,
            boolean_001=boolean_math(
                boolean=compare(
                    a=math(
                        value=math(
                            value=contour_start_count,
                            value_001=face_count * 1.0,
                            operation="SUBTRACT",
                        ),
                        operation="ABSOLUTE",
                    ),
                    b=0.0,
                    operation="GREATER_THAN",
                ),
                boolean_001=compare(
                    a=math(
                        value=math(
                            value=outer_start_count,
                            value_001=1.0,
                            operation="SUBTRACT",
                        ),
                        operation="ABSOLUTE",
                    ),
                    b=0.0,
                    operation="GREATER_THAN",
                ),
                operation="OR",
            ),
            operation="OR",
        ),
        operation="OR",
    )
    geometry_semantic_bad = boolean_math(
        boolean=compare(a=edge_pair_bad_any, b=0.5, operation="GREATER_THAN"),
        boolean_001=compare(a=containment_bad_any, b=0.5, operation="GREATER_THAN"),
        operation="OR",
    )
    semantic_bad = boolean_math(
        boolean=scalar_semantic_bad,
        boolean_001=geometry_semantic_bad,
        operation="OR",
    )

    legacy_ring_raw, legacy_w, _legacy_mesh, legacy_nf, legacy_n = skel_ring_legacy(
        outline=legacy_input
    )
    legacy_index = input_index() * 1.0
    legacy_nx = store_named_attribute(
        geometry=legacy_ring_raw, name="n0",
        value=math(
            value=math(value=legacy_index, value_001=1.0, operation="ADD"),
            value_001=legacy_nf, operation="MODULO",
        ),
        data_type="FLOAT", domain="POINT",
    )
    legacy_pv = store_named_attribute(
        geometry=legacy_nx, name="p0",
        value=math(
            value=math(
                value=math(
                    value=legacy_index, value_001=legacy_nf, operation="ADD"
                ),
                value_001=1.0, operation="SUBTRACT",
            ),
            value_001=legacy_nf, operation="MODULO",
        ),
        data_type="FLOAT", domain="POINT",
    )
    legacy_lav = store_named_attribute(
        geometry=legacy_pv, name="lav0", value=0.0,
        data_type="FLOAT", domain="POINT",
    )
    legacy_ed = store_named_attribute(
        geometry=legacy_lav, name="ed0", value=legacy_index,
        data_type="FLOAT", domain="POINT",
    )
    legacy_ring = store_named_attribute(
        geometry=legacy_ed, name="wq1", value=legacy_w,
        data_type="FLOAT", domain="POINT",
    )

    derived_ring_gable = store_named_attribute(
        geometry=derived_ring,
        name="g0",
        value=0,
        data_type="INT",
        domain="POINT",
    )
    non_authored_ring = switch(
        switch=derived_sel, false=legacy_ring, true=derived_ring_gable,
        input_type="GEOMETRY",
    )
    ring = switch(
        switch=canonical, false=non_authored_ring, true=canonical_ring,
        input_type="GEOMETRY",
    )
    ring_gable = input_named_attribute(name="g0", data_type="INT")
    gable_active = compare(
        a=ring_gable, b=1, operation="EQUAL", data_type="INT"
    )
    gable_value_bad = boolean_math(
        boolean=compare(
            a=ring_gable, b=0, operation="LESS_THAN", data_type="INT"
        ),
        boolean_001=compare(
            a=ring_gable, b=1, operation="GREATER_THAN", data_type="INT"
        ),
        operation="OR",
    )
    ring_next_gable = input_named_attribute(name="n0", data_type="FLOAT")
    ring_next_gable_i = float_to_int(
        float=ring_next_gable, rounding_mode="ROUND"
    )
    gable_next = sample_index(
        geometry=ring,
        value=ring_gable,
        index=ring_next_gable_i,
        data_type="INT",
        domain="POINT",
    )
    adjacent_gable = boolean_math(
        boolean=gable_active,
        boolean_001=compare(
            a=gable_next, b=1, operation="EQUAL", data_type="INT"
        ),
        operation="AND",
    )
    ring_gable_role = input_named_attribute(name="role", data_type="INT")
    hole_gable = boolean_math(
        boolean=gable_active,
        boolean_001=compare(
            a=ring_gable_role, b=1, operation="EQUAL", data_type="INT"
        ),
        operation="AND",
    )
    gable_row_bad_any = attribute_statistic(
        geometry=ring,
        attribute=switch(
            switch=boolean_math(
                boolean=boolean_math(
                    boolean=gable_value_bad,
                    boolean_001=adjacent_gable,
                    operation="OR",
                ),
                boolean_001=hole_gable,
                operation="OR",
            ),
            false=0.0,
            true=1.0,
            input_type="FLOAT",
        ),
        data_type="FLOAT",
        domain="POINT",
    ).max
    gable_active_count = attribute_statistic(
        geometry=ring,
        attribute=switch(
            switch=gable_active, false=0.0, true=1.0, input_type="FLOAT"
        ),
        data_type="FLOAT",
        domain="POINT",
    ).sum
    non_authored_nf = switch(
        switch=derived_sel, false=legacy_nf, true=derived_nf,
        input_type="FLOAT",
    )
    nf = switch(
        switch=canonical, false=non_authored_nf, true=row_count * 1.0,
        input_type="FLOAT",
    )
    non_authored_n = switch(
        switch=derived_sel, false=legacy_n, true=derived_n,
        input_type="INT",
    )
    ndom = switch(
        switch=canonical, false=non_authored_n, true=row_count,
        input_type="INT",
    )
    has_active_gable = compare(
        a=gable_active_count, b=0.5, operation="GREATER_THAN"
    )
    all_gabled = boolean_math(
        boolean=has_active_gable,
        boolean_001=boolean_math(
            boolean=compare(
                a=math(
                    value=math(
                        value=gable_active_count,
                        value_001=nf,
                        operation="SUBTRACT",
                    ),
                    operation="ABSOLUTE",
                ),
                b=0.0,
                operation="GREATER_THAN",
            ),
            operation="NOT",
        ),
        operation="AND",
    )
    canonical_multi_gable = boolean_math(
        boolean=canonical,
        boolean_001=boolean_math(
            boolean=has_active_gable,
            boolean_001=compare(
                a=contour_start_count, b=1.0, operation="GREATER_THAN"
            ),
            operation="AND",
        ),
        operation="AND",
    )
    gable_designation_bad = boolean_math(
        boolean=compare(
            a=gable_row_bad_any, b=0.5, operation="GREATER_THAN"
        ),
        boolean_001=boolean_math(
            boolean=all_gabled,
            boolean_001=canonical_multi_gable,
            operation="OR",
        ),
        operation="OR",
    )
    legacy_bad = boolean_math(
        boolean=boolean_math(
            boolean=compare(a=face_count, b=1, operation="NOT_EQUAL", data_type="INT"),
            boolean_001=compare(a=m, b=corner_count, operation="NOT_EQUAL", data_type="INT"),
            operation="OR",
        ),
        boolean_001=compare(a=m, b=3, operation="LESS_THAN", data_type="INT"),
        operation="OR",
    )
    canonical_dims_bad = boolean_math(
        boolean=boolean_math(
            boolean=compare(a=face_count, b=1, operation="LESS_THAN", data_type="INT"),
            boolean_001=compare(a=m, b=corner_count, operation="NOT_EQUAL", data_type="INT"),
            operation="OR",
        ),
        boolean_001=boolean_math(
            boolean=compare(a=row_count, b=3, operation="LESS_THAN", data_type="INT"),
            boolean_001=compare(
                a=row_count, b=corner_count, operation="NOT_EQUAL", data_type="INT"
            ),
            operation="OR",
        ),
        operation="OR",
    )
    derived_bad = boolean_math(
        boolean=derived_topology_bad,
        boolean_001=derived_carrier_bad,
        operation="OR",
    )
    non_authored_bad = switch(
        switch=derived_sel, false=legacy_bad, true=derived_bad,
        input_type="BOOLEAN",
    )
    carrier_bad = switch(
        switch=marker_any, false=non_authored_bad, true=canonical_dims_bad,
        input_type="BOOLEAN",
    )
    canonical_semantic_bad = boolean_math(
        boolean=canonical, boolean_001=semantic_bad, operation="AND"
    )
    carrier_or_semantic_bad = boolean_math(
        boolean=boolean_math(
            boolean=schema_bad, boolean_001=carrier_bad, operation="OR"
        ),
        boolean_001=canonical_semantic_bad,
        operation="OR",
    )
    c9_bad = boolean_math(
        boolean=carrier_or_semantic_bad,
        boolean_001=gable_designation_bad,
        operation="OR",
    )
    c1_bad = boolean_math(
        boolean=boolean_math(
            boolean=canonical, boolean_001=authored_c1_bad, operation="AND"
        ),
        boolean_001=boolean_math(
            boolean=derived_sel, boolean_001=derived_c1_bad, operation="AND"
        ),
        operation="OR",
    )
    ring_w = input_named_attribute(name="wq1", data_type="FLOAT")
    return (ring, ring_w, ring, nf, ndom, c9_bad, c1_bad, canonical)


@node_tree(id="opus.gnslice.frontinit.v1", target="geometry")
def skel_front_init(
    ring: Geometry, ring_w: Float, nf: Float
) -> tuple[Geometry, Float, Vector, Vector, Vector, Float, Float]:
    """Prepare S2a (structural step 15): front initialisation on the ring —
    neighbour modulo math, out-edge normal, authored/solver weight separation,
    vel2 seed velocity, and the full ap/at/vl/nx/pv/ed/lv/bo/rf store chain
    producing front_live. No zone specials;
    input_index()/input_position() are element fields in group scope).
    Field outputs consumed by validate (pos_j/edge_in/edge_dir/w_in_authored/
    sep_c.z) and pool (idx_f) cross as unpinned fields — lane-proven shape.
    In-span-only names: nxt0, prv0, nxt0_i, prv0_i, edge_u, sep_u, nrm_out,
    f_nr, nrm_in, f_w, vel_0, f_ap, f_at, f_vl, f_nx, f_pv, f_ed, f_lv,
    pos_pv, crs, rf_b, rf_v, f_bo.
    """
    idx_f = input_index() * 1.0
    nxt0 = input_named_attribute(name="n0", data_type="FLOAT")
    prv0 = input_named_attribute(name="p0", data_type="FLOAT")
    edge0 = input_named_attribute(name="ed0", data_type="FLOAT")
    lav0 = input_named_attribute(name="lav0", data_type="FLOAT")
    nxt0_i = float_to_int(float=nxt0, rounding_mode="ROUND")
    prv0_i = float_to_int(float=prv0, rounding_mode="ROUND")

    pos_j = sample_index(
        geometry=ring,
        value=input_position(),
        index=nxt0_i,
        data_type="FLOAT_VECTOR",
        domain="POINT",
    )
    edge_dir = vector_math(
        vector=pos_j, vector_001=input_position(), operation="SUBTRACT"
    )
    edge_u = vector_math(vector=edge_dir, operation="NORMALIZE")
    sep_u = separate_xyz(vector=edge_u)
    nrm_out = combine_xyz(x=sep_u.y * -1.0, y=sep_u.x, z=0.0)

    f_nr = store_named_attribute(
        geometry=ring,
        name="nr",
        value=nrm_out,
        data_type="FLOAT_VECTOR",
        domain="POINT",
    )
    nrm_in = sample_index(
        geometry=f_nr,
        value=input_named_attribute(name="nr", data_type="FLOAT_VECTOR"),
        index=prv0_i,
        data_type="FLOAT_VECTOR",
        domain="POINT",
    )
    ring_gable = input_named_attribute(name="g0", data_type="INT")
    gable_out = compare(
        a=ring_gable, b=1, operation="EQUAL", data_type="INT"
    )
    gable_in_value = sample_index(
        geometry=ring,
        value=ring_gable,
        index=prv0_i,
        data_type="INT",
        domain="POINT",
    )
    gable_in = compare(
        a=gable_in_value, b=1, operation="EQUAL", data_type="INT"
    )
    w_in_authored = sample_index(
        geometry=ring,
        value=ring_w,
        index=prv0_i,
        data_type="FLOAT",
        domain="POINT",
    )
    solve_w_out = switch(
        switch=gable_out, false=ring_w, true=0.0, input_type="FLOAT"
    )
    solve_w_in = switch(
        switch=gable_in, false=w_in_authored, true=0.0, input_type="FLOAT"
    )
    f_w = store_named_attribute(
        geometry=f_nr,
        name="w",
        value=solve_w_out,
        data_type="FLOAT",
        domain="POINT",
    )
    vel_0 = vel2(
        na=nrm_in, nb=nrm_out, wp=solve_w_in, wq=solve_w_out
    )

    f_ap = store_named_attribute(
        geometry=f_w,
        name="ap",
        value=input_position(),
        data_type="FLOAT_VECTOR",
        domain="POINT",
    )
    f_at = store_named_attribute(
        geometry=f_ap, name="at", value=0.0, data_type="FLOAT", domain="POINT"
    )
    f_vl = store_named_attribute(
        geometry=f_at, name="vl", value=vel_0, data_type="FLOAT_VECTOR", domain="POINT"
    )
    f_nx = store_named_attribute(
        geometry=f_vl, name="nx", value=nxt0, data_type="FLOAT", domain="POINT"
    )
    f_pv = store_named_attribute(
        geometry=f_nx, name="pv", value=prv0, data_type="FLOAT", domain="POINT"
    )
    f_ed = store_named_attribute(
        geometry=f_pv, name="ed", value=edge0, data_type="FLOAT", domain="POINT"
    )
    f_lav = store_named_attribute(
        geometry=f_ed, name="lav", value=lav0, data_type="FLOAT", domain="POINT"
    )
    f_lv = store_named_attribute(
        geometry=f_lav, name="lv", value=1.0, data_type="FLOAT", domain="POINT"
    )
    # A1 reflex mask (CCW ring: reflex iff cross(in-edge, out-edge) < 0) and
    # birth order (initial slots: bo = slot id; newborns later get N+counter).
    pos_pv = sample_index(
        geometry=ring,
        value=input_position(),
        index=prv0_i,
        data_type="FLOAT_VECTOR",
        domain="POINT",
    )
    edge_in = vector_math(
        vector=input_position(), vector_001=pos_pv, operation="SUBTRACT"
    )
    crs = vector_math(vector=edge_in, vector_001=edge_dir, operation="CROSS_PRODUCT")
    sep_c = separate_xyz(vector=crs)
    rf_b = compare(a=sep_c.z, b=0.0, operation="LESS_THAN")
    # An initial equal-weight same-direction rider is split-eligible. Its
    # retained split/caps path closes the centered three-member chain without
    # introducing a new event class.
    sep_ni = separate_xyz(vector=nrm_in)
    det_io = sep_ni.x * sep_u.x + sep_ni.y * sep_u.y
    dot_io = sep_ni.x * sep_u.y * -1.0 + sep_ni.y * sep_u.x
    rider_geom_b = boolean_math(
        boolean=compare(
            a=math(value=det_io, operation="ABSOLUTE"), b=1e-12, operation="LESS_THAN"
        ),
        boolean_001=compare(a=dot_io, b=0.0, operation="GREATER_THAN"),
        operation="AND",
    )
    rider_w_eq = boolean_math(
        boolean=compare(
            a=math(value=solve_w_in - solve_w_out, operation="ABSOLUTE"),
            b=0.0,
            operation="GREATER_THAN",
        ),
        operation="NOT",
    )
    rider_b = boolean_math(
        boolean=rider_geom_b, boolean_001=rider_w_eq, operation="AND"
    )
    rf_b2 = boolean_math(boolean=rf_b, boolean_001=rider_b, operation="OR")
    rf_v = switch(switch=rf_b2, false=0.0, true=1.0, input_type="FLOAT")
    f_bo = store_named_attribute(
        geometry=f_lv, name="bo", value=idx_f, data_type="FLOAT", domain="POINT"
    )
    front_live = store_named_attribute(
        geometry=f_bo, name="rf", value=rf_v, data_type="FLOAT", domain="POINT"
    )
    front_solve = remove_attribute(geometry=front_live, name="g0")
    return (
        front_solve, idx_f, pos_j, edge_in, edge_dir, w_in_authored, sep_c.z
    )


@node_tree(id="opus.gnslice.validate.v1", target="geometry")
def skel_validate(
    mesh_w: Geometry,
    front_live: Geometry,
    ring_w: Float,
    w_in: Float,
    pos_j: Vector,
    edge_in: Vector,
    edge_dir: Vector,
    sep_c_z: Float,
) -> Boolean:
    """Prepare S2b (structural step 16): the rung-3a input-validation
    contract -> w8_bad (code 8 invalid_weights). Weight domain on the
    RESOLVED carrier, R_max=100 ratio, the two-axis input-scale window,
    CCW orientation shoelace, and collinear-run-with-unequal-weights.
    Body byte-verbatim; the dangling element fields (pxw/sep_p over
    front_live, pos_j/edge_in/edge_dir/sep_c_z/w_in forwarded from
    front_init) re-bind at each statistic's context — lane-proven shape.
    """
    # ---- rung-3a input validation (SPEC 1) -> code 8 invalid_weights ----
    # Weight domain: positivity + finiteness on the RESOLVED carrier (an
    # absent layer resolves to all-1.0 and trips nothing; a partially
    # written layer reads 0.0 on unwritten points and trips <= 0).
    # Non-finite via w - w: finite values give exactly 0, NaN and +-inf
    # give NaN (IEEE), so EQUAL 0 is a finiteness test.
    wq1_f = input_named_attribute(name="wq1", data_type="FLOAT")
    w_d = math(value=wq1_f, value_001=wq1_f, operation="SUBTRACT")
    w_fin = compare(a=w_d, b=0.0, operation="EQUAL")
    w_pos = compare(a=wq1_f, b=0.0, operation="GREATER_THAN")
    w_bad_pt = boolean_math(
        boolean=boolean_math(
            boolean=w_fin, boolean_001=w_pos, operation="AND"
        ),
        operation="NOT",
    )
    w_bad_any = attribute_statistic(
        geometry=mesh_w,
        attribute=switch(
            switch=w_bad_pt, false=0.0, true=1.0, input_type="FLOAT"
        ),
        data_type="FLOAT",
        domain="POINT",
    ).max
    wq1_stat = attribute_statistic(
        geometry=mesh_w, attribute=wq1_f, data_type="FLOAT", domain="POINT"
    )
    w_hi = wq1_stat.max
    w_lo = wq1_stat.min
    # R_max = 100 closed weight-domain contract (SPEC 1). A tripped <= 0
    # makes this ratio garbage/NaN, but w_bad_any already fired — the OR
    # below does not depend on the ratio being meaningful then.
    w_ratio_bad = compare(
        a=math(value=w_hi, value_001=w_lo, operation="DIVIDE"),
        b=100.0,
        operation="GREATER_THAN",
    )
    # Mechanism 3 (task #14): declared two-axis input-scale window,
    # enforced in code 8 (contract R2 tie_thr/w8_bad rows;
    # REF-CROSSCHECK FINAL "declare a scale contract" — the
    # Briganti-style unit-ish-scale assumption made explicit and
    # tested, because float references guarantee nothing at untested
    # scales and neither do we).
    #   POSITION axis: extent E = max(x_range, y_range) in [1e-2, 1e4].
    #     Floor: keeps the rf classifier's -1e-6 determinant slack at
    #     <= 1% of a unit-collinearity det (corner resolution
    #     slack/E_LO^2 = 1e-2 rad at the floor, improving with E^2).
    #     Ceiling: worst-case event time E/W_LO = 1e8 stays a 5x
    #     margin under the 5e8 no_event sentinel.
    #   WEIGHT axis: every resolved w in [1e-4, 1e4]. Floor = the
    #     lowest TESTED uniform scale (c=1e-4, metamorphic green),
    #     inclusive at the f32 bit; rejects c <= ~1e-5 (c=1e-6 leaves
    #     corpus w <= 1.46e-5 < 1e-4, >6x margin). Ceiling = 12.5x
    #     above corpus max 14.6; c=1e2 tested. Inside the window the
    #     tie band is purely relative (see tie_thr); outside it we
    #     reject rather than claim untested invariance.
    # Corpus-inclusion proof: test_code8_conditioning.py
    # (every fixture in both frozen roots sits inside).
    pxw = separate_xyz(vector=input_position())
    pos_stat = attribute_statistic(
        geometry=front_live, attribute=pxw,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    stat_hi = separate_xyz(vector=pos_stat.max)
    stat_lo = separate_xyz(vector=pos_stat.min)
    x_max_w = stat_hi.x
    x_min_w = stat_lo.x
    y_max_w = stat_hi.y
    y_min_w = stat_lo.y
    ext_w = math(
        value=math(value=x_max_w, value_001=x_min_w, operation="SUBTRACT"),
        value_001=math(value=y_max_w, value_001=y_min_w, operation="SUBTRACT"),
        operation="MAXIMUM",
    )
    ext_bad = boolean_math(
        boolean=compare(a=ext_w, b=1e-2, operation="LESS_THAN"),
        boolean_001=compare(a=ext_w, b=1e4, operation="GREATER_THAN"),
        operation="OR",
    )
    wsc_bad = boolean_math(
        boolean=compare(a=w_lo, b=1e-4, operation="LESS_THAN"),
        boolean_001=compare(a=w_hi, b=1e4, operation="GREATER_THAN"),
        operation="OR",
    )
    win_bad = boolean_math(boolean=ext_bad, boolean_001=wsc_bad, operation="OR")
    # Orientation: shoelace sum over ring slots, CCW > 0. The oracle
    # REMAPS CW input; the rung-3a input contract REJECTS it (code 8).
    sep_p = separate_xyz(vector=input_position())
    sep_j = separate_xyz(vector=pos_j)
    area_sum = attribute_statistic(
        geometry=front_live,
        attribute=math(
            value=math(value=sep_p.x, value_001=sep_j.y, operation="MULTIPLY"),
            value_001=math(value=sep_j.x, value_001=sep_p.y, operation="MULTIPLY"),
            operation="SUBTRACT",
        ),
        data_type="FLOAT",
        domain="POINT",
    ).sum
    cw_bad = compare(a=area_sum, b=0.0, operation="LESS_THAN")
    # Collinear run with UNEQUAL weights = input-contract violation
    # (oracle :2543 raises before base_collinear). Tolerance mirrors
    # _merge_collinear_run: |cross(ab, bc)| <= 1e-12 * max(|ab|*|bc|,
    # 1e-12). GN is native f32, so exact equality means equality of the
    # authored values after their POINT/FLOAT carrier quantization. Do not use
    # Compare/EQUAL here: its active default Epsilon admits unequal weights.
    lin_thr = math(
        value=math(
            value=math(
                value=vector_math(vector=edge_in, operation="LENGTH"),
                value_001=vector_math(vector=edge_dir, operation="LENGTH"),
                operation="MULTIPLY",
            ),
            value_001=1e-12,
            operation="MAXIMUM",
        ),
        value_001=1e-12,
        operation="MULTIPLY",
    )
    col_bad_pt = boolean_math(
        boolean=compare(
            a=math(value=sep_c_z, operation="ABSOLUTE"),
            b=lin_thr,
            operation="LESS_EQUAL",
        ),
        boolean_001=compare(
            a=math(value=w_in - ring_w, operation="ABSOLUTE"),
            b=0.0,
            operation="GREATER_THAN",
        ),
        operation="AND",
    )
    col_bad_any = attribute_statistic(
        geometry=front_live,
        attribute=switch(
            switch=col_bad_pt, false=0.0, true=1.0, input_type="FLOAT"
        ),
        data_type="FLOAT",
        domain="POINT",
    ).max
    w8_bad = boolean_math(
        boolean=boolean_math(
            boolean=boolean_math(
                boolean=compare(a=w_bad_any, b=0.5, operation="GREATER_THAN"),
                boolean_001=compare(
                    a=col_bad_any, b=0.5, operation="GREATER_THAN"
                ),
                operation="OR",
            ),
            boolean_001=boolean_math(
                boolean=cw_bad, boolean_001=w_ratio_bad, operation="OR"
            ),
            operation="OR",
        ),
        boolean_001=win_bad,
        operation="OR",
    )
    return w8_bad


@node_tree(id="opus.gnslice.pool.v1", target="geometry")
def skel_pool(
    nf: Float, ndom: Integer, idx_f: Float, front_live: Geometry
) -> tuple[Geometry, Geometry, Integer]:
    """Prepare S2c (structural step 17): the A1 multi-LAV record pool —
    N live ring slots + N-2 inert spare slots joined in index order,
    lav/td/ncor/ps constant stores, empty arcs0 cloud, and the pool_n
    walk budget. Body byte-verbatim; idx_f crosses IN as an unpinned
    field (stored on the spare cloud it re-binds to the spare element
    index — the original semantics). Outputs: front0, arcs0, pool_n.
    """
    # Rung-3b bounded v1 pool policy: M initial slots + 3*M inert spare
    # slots = 4*M total. This is the owner's measured engineering policy,
    # not a universal holed-polygon theorem. Authored per-contour lav ids on
    # the initial front are preserved; only spare rows start at lav 0.
    spare_n_f = math(value=nf, value_001=3.0, operation="MULTIPLY")
    spare_cnt = float_to_int(float=spare_n_f, rounding_mode="ROUND")
    # pool_n: walk budget for the per-body lav re-stamp (lavring) — any slot
    # must reach its circle's anchor within one lap of the whole pool.
    pool_n = float_to_int(
        float=math(value=nf, value_001=spare_n_f, operation="ADD"),
        rounding_mode="ROUND",
    )
    spare_mesh = mesh_line(
        count=spare_cnt,
        start_location=(0.0, 0.0, 0.0),
        offset=(0.0, 0.0, 0.0),
        mode="OFFSET",
        count_mode="TOTAL",
    )
    spare_pts = mesh_to_points(mesh=spare_mesh, mode="VERTICES")
    zero_v = combine_xyz(x=0.0, y=0.0, z=0.0)
    s_lv = store_named_attribute(
        geometry=spare_pts, name="lv", value=0.0, data_type="FLOAT", domain="POINT"
    )
    s_ap = store_named_attribute(
        geometry=s_lv, name="ap", value=zero_v, data_type="FLOAT_VECTOR", domain="POINT"
    )
    s_at = store_named_attribute(
        geometry=s_ap, name="at", value=0.0, data_type="FLOAT", domain="POINT"
    )
    s_vl = store_named_attribute(
        geometry=s_at, name="vl", value=zero_v, data_type="FLOAT_VECTOR", domain="POINT"
    )
    s_nr = store_named_attribute(
        geometry=s_vl, name="nr", value=zero_v, data_type="FLOAT_VECTOR", domain="POINT"
    )
    s_nx = store_named_attribute(
        geometry=s_nr, name="nx", value=idx_f, data_type="FLOAT", domain="POINT"
    )
    s_pv = store_named_attribute(
        geometry=s_nx, name="pv", value=idx_f, data_type="FLOAT", domain="POINT"
    )
    s_ed = store_named_attribute(
        geometry=s_pv, name="ed", value=0.0, data_type="FLOAT", domain="POINT"
    )
    s_bo = store_named_attribute(
        geometry=s_ed, name="bo", value=idx_f, data_type="FLOAT", domain="POINT"
    )
    spare_init = store_named_attribute(
        geometry=s_bo, name="rf", value=0.0, data_type="FLOAT", domain="POINT"
    )
    # lav: circle (LAV) id for the scan gate + cross-LAV latch (code 6). One
    # circle at init (0); a split's TWO child circles each take a fresh id
    # (A: lc+n_acc+iA, B: lc+iB; lc advances 2*n_acc per body), walked onto
    # the full circle membership by `lavring` at the fold output — task #6.
    s_lav = store_named_attribute(
        geometry=spare_init, name="lav", value=0.0, data_type="FLOAT", domain="POINT"
    )
    pool = join_geometry([front_live, s_lav])
    pool_td = store_named_attribute(
        geometry=pool, name="td", value=0.0, data_type="FLOAT", domain="POINT"
    )
    # ncor: live-slot count N, so the zone body can derive the B-slot base
    # N + bc without capturing outer locals (ncor/ps are per-point constants).
    pool_nc = store_named_attribute(
        geometry=pool_td,
        name="ncor",
        value=ndom * 1.0,
        data_type="FLOAT",
        domain="POINT",
    )
    front0 = store_named_attribute(
        geometry=pool_nc,
        name="ps",
        value=ndom * 1.0 + spare_n_f,
        data_type="FLOAT",
        domain="POINT",
    )
    arcs0 = points(count=0)
    return (front0, arcs0, pool_n)


@node_tree(id="opus.gnslice.style_arcs.v1", target="geometry")
def skel_style_arcs(arcs: Geometry) -> Geometry:
    """Stamp exact post-solve semantics while arc records still own ``cp``."""
    cp = input_named_attribute(name="cp", data_type="FLOAT")
    al = input_named_attribute(name="al", data_type="FLOAT")
    ar = input_named_attribute(name="ar", data_type="FLOAT")
    is_wavefront = compare(a=cp, b=0.5, operation="LESS_THAN")
    above_terminal = compare(a=cp, b=1.5, operation="GREATER_THAN")
    below_cap = compare(a=cp, b=2.5, operation="LESS_THAN")
    is_terminal = boolean_math(
        boolean=above_terminal, boolean_001=below_cap, operation="AND"
    )
    is_cap = compare(a=cp, b=2.5, operation="GREATER_THAN")
    cap_class = switch(
        switch=is_cap, false=0, true=4, input_type="INT"
    )
    nonwave_class = switch(
        switch=is_terminal, false=cap_class, true=3, input_type="INT"
    )
    arc_class = switch(
        switch=is_wavefront, false=nonwave_class, true=2, input_type="INT"
    )
    left_face = float_to_int(float=al, rounding_mode="ROUND")
    right_face = float_to_int(float=ar, rounding_mode="ROUND")
    styled_class = store_named_attribute(
        geometry=arcs,
        name="k3_skeleton_arc_class",
        value=arc_class,
        data_type="INT",
        domain="POINT",
    )
    styled_left = store_named_attribute(
        geometry=styled_class,
        name="k3_left_roof_face_id",
        value=left_face,
        data_type="INT",
        domain="POINT",
    )
    return store_named_attribute(
        geometry=styled_left,
        name="k3_right_roof_face_id",
        value=right_face,
        data_type="INT",
        domain="POINT",
    )


@node_tree(id="opus.gnslice.cap_emit.v1", target="geometry")
def skel_cap_emit(
    front: Geometry,
    arcs: Geometry,
    t_cap: Float,
    active: Boolean,
    weld_distance: Float,
) -> tuple[Geometry, Geometry, Boolean]:
    """Terminate the surviving LAVs at ``t_cap`` and fill their plateau.

    The event solver remains authoritative up to the last event at or below
    the cap.  This post-solve stage advances only the still-live, non-2-ring
    front records to the cap time, emits their truncated travel arcs (cp=0),
    emits one cap segment per surviving edge (cp=3), and fills all resulting
    cyclic contours together with Fill Curve's Even-Odd rule.  The original
    pool slot is pinned as ``ci`` before dead/padding rows are deleted because
    nx/pv address the un-compacted front.
    """
    slot_f = input_index() * 1.0
    slot_i = float_to_int(float=slot_f, rounding_mode="ROUND")
    lv_f = input_named_attribute(name="lv", data_type="FLOAT")
    nx_f = input_named_attribute(name="nx", data_type="FLOAT")
    alive = compare(a=lv_f, b=0.5, operation="GREATER_THAN")
    nx_o = sample_index(
        geometry=front, value=nx_f, index=slot_i,
        data_type="FLOAT", domain="POINT",
    )
    nx_i = float_to_int(float=nx_o, rounding_mode="ROUND")
    nx2_f = sample_index(
        geometry=front, value=nx_f, index=nx_i,
        data_type="FLOAT", domain="POINT",
    )
    nx2_le_slot = compare(a=nx2_f, b=slot_f, operation="LESS_EQUAL")
    nx2_ge_slot = compare(a=nx2_f, b=slot_f, operation="GREATER_EQUAL")
    nx2_is_slot = boolean_math(
        boolean=nx2_le_slot, boolean_001=nx2_ge_slot, operation="AND"
    )
    ring2 = boolean_math(
        boolean=alive, boolean_001=nx2_is_slot, operation="AND"
    )
    member = boolean_math(
        boolean=boolean_math(boolean=active, boolean_001=alive, operation="AND"),
        boolean_001=boolean_math(boolean=ring2, operation="NOT"),
        operation="AND",
    )
    indexed = store_named_attribute(
        geometry=front, name="ci", value=slot_f,
        data_type="FLOAT", domain="POINT",
    )
    members = delete_geometry(
        geometry=indexed,
        selection=boolean_math(boolean=member, operation="NOT"),
        mode="ALL", domain="POINT",
    )

    ci_f = input_named_attribute(name="ci", data_type="FLOAT")
    ci_i = float_to_int(float=ci_f, rounding_mode="ROUND")
    ap_f = input_named_attribute(name="ap", data_type="FLOAT_VECTOR")
    at_f = input_named_attribute(name="at", data_type="FLOAT")
    vl_f = input_named_attribute(name="vl", data_type="FLOAT_VECTOR")
    pv_f = input_named_attribute(name="pv", data_type="FLOAT")
    ed_f = input_named_attribute(name="ed", data_type="FLOAT")
    ap_i = sample_index(
        geometry=front, value=ap_f, index=ci_i,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    at_i = sample_index(
        geometry=front, value=at_f, index=ci_i,
        data_type="FLOAT", domain="POINT",
    )
    vl_i = sample_index(
        geometry=front, value=vl_f, index=ci_i,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    nx_member_f = sample_index(
        geometry=front, value=nx_f, index=ci_i,
        data_type="FLOAT", domain="POINT",
    )
    nx_member_i = float_to_int(float=nx_member_f, rounding_mode="ROUND")
    pv_member_f = sample_index(
        geometry=front, value=pv_f, index=ci_i,
        data_type="FLOAT", domain="POINT",
    )
    pv_member_i = float_to_int(float=pv_member_f, rounding_mode="ROUND")
    ed_i = sample_index(
        geometry=front, value=ed_f, index=ci_i,
        data_type="FLOAT", domain="POINT",
    )
    prev_ed = sample_index(
        geometry=front, value=ed_f, index=pv_member_i,
        data_type="FLOAT", domain="POINT",
    )
    ap_next = sample_index(
        geometry=front, value=ap_f, index=nx_member_i,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    at_next = sample_index(
        geometry=front, value=at_f, index=nx_member_i,
        data_type="FLOAT", domain="POINT",
    )
    vl_next = sample_index(
        geometry=front, value=vl_f, index=nx_member_i,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    cap_pos = vector_math(
        vector=ap_i,
        vector_001=vector_math(
            vector=vl_i, scale=t_cap - at_i, operation="SCALE"
        ),
        operation="ADD",
    )
    cap_next = vector_math(
        vector=ap_next,
        vector_001=vector_math(
            vector=vl_next, scale=t_cap - at_next, operation="SCALE"
        ),
        operation="ADD",
    )
    ap_xyz = separate_xyz(vector=ap_i)
    cap_xyz = separate_xyz(vector=cap_pos)
    next_xyz = separate_xyz(vector=cap_next)
    travel_a = combine_xyz(x=ap_xyz.x, y=ap_xyz.y, z=at_i)
    cap_a = combine_xyz(x=cap_xyz.x, y=cap_xyz.y, z=t_cap)
    cap_b = combine_xyz(x=next_xyz.x, y=next_xyz.y, z=t_cap)

    travel1 = store_named_attribute(
        geometry=members, name="aa", value=travel_a,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    travel2 = store_named_attribute(
        geometry=travel1, name="bb", value=cap_a,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    travel3 = store_named_attribute(
        geometry=travel2, name="al", value=prev_ed,
        data_type="FLOAT", domain="POINT",
    )
    travel4 = store_named_attribute(
        geometry=travel3, name="ar", value=ed_i,
        data_type="FLOAT", domain="POINT",
    )
    travel5 = store_named_attribute(
        geometry=travel4, name="sq", value=-1.0,
        data_type="FLOAT", domain="POINT",
    )
    travel6 = store_named_attribute(
        geometry=travel5, name="cp", value=0.0,
        data_type="FLOAT", domain="POINT",
    )
    travel = delete_geometry(
        geometry=travel6,
        selection=compare(
            a=t_cap - at_i, b=weld_distance, operation="LESS_EQUAL"
        ),
        mode="ALL", domain="POINT",
    )

    cap1 = store_named_attribute(
        geometry=members, name="aa", value=cap_a,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    cap2 = store_named_attribute(
        geometry=cap1, name="bb", value=cap_b,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    cap3 = store_named_attribute(
        geometry=cap2, name="al", value=ed_i,
        data_type="FLOAT", domain="POINT",
    )
    cap4 = store_named_attribute(
        geometry=cap3, name="ar", value=ed_i,
        data_type="FLOAT", domain="POINT",
    )
    cap5 = store_named_attribute(
        geometry=cap4, name="sq", value=-1.0,
        data_type="FLOAT", domain="POINT",
    )
    cap_records = store_named_attribute(
        geometry=cap5, name="cp", value=3.0,
        data_type="FLOAT", domain="POINT",
    )
    cap_length = vector_math(
        vector=cap_pos, vector_001=cap_next, operation="DISTANCE"
    ).value
    short_cap = compare(a=cap_length, b=weld_distance, operation="LESS_EQUAL")
    short_count = attribute_statistic(
        geometry=cap_records, selection=short_cap, attribute=1.0,
        data_type="FLOAT", domain="POINT",
    ).sum
    cap_bad = compare(a=short_count, b=0.5, operation="GREATER_THAN")

    seg = mesh_line(
        count=2, start_location=(0.0, 0.0, 0.0),
        offset=(0.0, 0.0, 1.0), mode="OFFSET", count_mode="TOTAL",
    )
    seg_marked = store_named_attribute(
        geometry=seg, name="ce", value=input_index() * 1.0,
        data_type="FLOAT", domain="POINT",
    )
    cap_inst = instance_on_points(points=cap_records, instance=seg_marked)
    cap_real = realize_instances(geometry=cap_inst)
    endpoint = input_named_attribute(name="ce", data_type="FLOAT")
    use_b = compare(a=endpoint, b=0.5, operation="GREATER_THAN")
    aa_c = input_named_attribute(name="aa", data_type="FLOAT_VECTOR")
    bb_c = input_named_attribute(name="bb", data_type="FLOAT_VECTOR")
    cap_vertex = switch(switch=use_b, false=aa_c, true=bb_c, input_type="VECTOR")
    cap_edges = set_position(geometry=cap_real, position=cap_vertex)
    cap_weld = merge_by_distance(geometry=cap_edges, distance=weld_distance)
    cap_curve = mesh_to_curve(mesh=cap_weld)
    cap_cyclic = set_spline_cyclic(curve=cap_curve, cyclic=True)
    plateau_flat = fill_curve(
        curve=cap_cyclic, mode="N-gons", fill_rule="Even-Odd"
    )
    plateau_xyz = separate_xyz(vector=input_position())
    plateau = set_position(
        geometry=plateau_flat,
        position=(plateau_xyz.x, plateau_xyz.y, t_cap),
    )
    return join_geometry([arcs, travel, cap_records]), plateau, cap_bad


@node_tree(id="opus.gnslice.faces.v1", target="geometry")
def skel_faces(
    ring: Geometry,
    arcs_end: Geometry,
    nf: Float,
    aa_f: Vector,
    bb_f: Vector,
    al_f: Float,
    ar_f: Float,
    cp_f: Float,
    identity_stable: Boolean,
    weld_distance: Float = 0.00001,
) -> Geometry:
    """Post-solve S8+S8b (structural step 18): roof faces. S8 stamps the
    eave corner points and parent-tagged arc endpoints (grp), flattens the
    face-point cloud carrying `pz` heights; S8b fills one N-gon per ordinary
    wall in a topology-first repeat zone (welded arc chains + eave edge),
    stamps gable-neighbor supporting-line edges as VERGE, then the
    nearest-plan-point lookup puts height back. The
    aa/bb/al/ar/cp dangling field reads stay at the CALLER (the evidence
    region consumes them too) and cross IN as params. The fill_faces zone
    moves as a whole — its `index` is its own Iteration socket (zone
    specials are legal inside their zone; chase/lavring precedent for a
    zone nested in a def).
    """
    # ---------- S8: roof faces from parent-tagged arcs ---------------------
    eave_f = input_index() * 1.0
    # Multi-contour carriers are globally packed but each wall closes only to
    # its own contour successor. `n0` is the canonical ring-local neighbor;
    # global (k+1)%N crosses outer->hole and hole->outer at both boundaries.
    eave_nx = input_named_attribute(name="n0", data_type="FLOAT")
    eave_nx_i = float_to_int(float=eave_nx, rounding_mode="ROUND")
    corner_next = sample_index(
        geometry=ring,
        value=input_position(),
        index=eave_nx_i,
        data_type="FLOAT_VECTOR",
        domain="POINT",
    )
    pts_c0 = store_named_attribute(
        geometry=ring, name="grp", value=eave_f, data_type="FLOAT", domain="POINT"
    )
    k2 = set_position(geometry=ring, position=corner_next)
    pts_c1 = store_named_attribute(
        geometry=k2, name="grp", value=eave_f, data_type="FLOAT", domain="POINT"
    )

    l1 = set_position(geometry=arcs_end, position=bb_f)
    l2 = store_named_attribute(
        geometry=l1, name="grp", value=al_f, data_type="FLOAT", domain="POINT"
    )
    pts_left = delete_geometry(
        geometry=l2,
        selection=compare(a=cp_f, b=0.5, operation="GREATER_THAN"),
        mode="ALL",
        domain="POINT",
    )

    ar_i = float_to_int(float=ar_f, rounding_mode="ROUND")
    corner_own = sample_index(
        geometry=ring,
        value=input_position(),
        index=ar_i,
        data_type="FLOAT_VECTOR",
        domain="POINT",
    )
    d_corner = vector_math(
        vector=aa_f, vector_001=corner_own, operation="DISTANCE"
    ).value
    m1 = set_position(geometry=arcs_end, position=aa_f)
    m2 = store_named_attribute(
        geometry=m1, name="grp", value=ar_f, data_type="FLOAT", domain="POINT"
    )
    is_ridge_rec = compare(a=cp_f, b=1.5, operation="GREATER_THAN")
    at_corner = compare(a=d_corner, b=1e-5, operation="LESS_THAN")
    drop_right = boolean_math(
        boolean=is_ridge_rec, boolean_001=at_corner, operation="OR"
    )
    pts_right = delete_geometry(
        geometry=m2, selection=drop_right, mode="ALL", domain="POINT"
    )

    face_pts_raw = join_geometry([pts_c0, pts_c1, pts_left, pts_right])
    # Fill Curve is a PLANAR (XY) fill that ALSO drops every custom attribute.
    # Both halves were measured directly in background Blender 5.2 (probe
    # `probe_fill.py`, see ARTIFACT.md section 5): a cyclic curve whose four
    # control points sit at z = 0, 1, 2, 1 fills to a mesh whose four vertices
    # are all at z = 0 (plan area 4.0, not the tilted area), and the evaluated
    # attribute list of that mesh is exactly
    # ['.corner_edge', '.corner_vert', '.edge_verts', 'position', 'sharp_face']
    # -- a `pp` vector attribute stored on the points before the fill is gone.
    # So height cannot ride across the fill on an attribute. It is looked up
    # again afterwards instead: the straight-skeleton roof is a HEIGHT FUNCTION
    # over the plan, so a plan XY determines z uniquely even where several
    # faces meet. Carry the true height on a flattened copy of the face-point
    # cloud as `pz`, and after the fill resolve every output vertex by nearest
    # plan point. Each roof face is planar by construction and its plan
    # projection is a simple polygon, so the plan-view fill produces the
    # correct n-gon topology; only the height has to be put back.
    pz_pts = store_named_attribute(
        geometry=face_pts_raw,
        name="pz",
        value=separate_xyz(vector=input_position()).z,
        data_type="FLOAT",
        domain="POINT",
    )
    fp_xyz = separate_xyz(vector=input_position())
    face_pts = set_position(
        geometry=pz_pts, position=(fp_xyz.x, fp_xyz.y, 0.0)
    )
    # ---------- S8b: one fill per wall, TOPOLOGY-FIRST (repeat zone) --------
    # Face k's boundary is the welded chain of its parent-tagged arcs plus
    # the eave segment — connectivity IS the order; no geometric sort key
    # reconstructs it in general. Verified against the frozen oracle arcs
    # (probe 2026-08-23, all 13 fixtures): for every face, the union of
    # segments {arc : pl == k or pr == k} + the eave segment welds into a
    # single degree-2 closed cycle equal to the oracle's face cycle (only
    # exceptions: hex faces 1/4's zero-length terminal arc — the
    # pre-registered oracle artifact the comparator suppresses). Sort keys
    # failed twice before this: angular-around-midpoint assumed star-shaped
    # faces (broken by fx8's two-splits-on-one-wall zigzag, where a ray
    # from the midpoint crosses the boundary twice) and along-wall
    # projection assumed Lemma-4 chain monotonicity (broken by
    # corner-overshoot chains — measured fx2 face 4: proj dips to -1.326
    # past ea then returns to 0). Construction: per wall, realize a 2-vert
    # unit line per arc record (the evidence-geometry idiom), set its
    # vertices to aa/bb by index parity, add the eave edge, weld shared
    # endpoints at 1e-5 (the event-precision scale), convert the welded
    # edge chain to a curve, close it, fill N-gon even-odd. Shared skeleton
    # nodes stay separate per-face copies exactly as the oracle's per-wall
    # faces do.
    wall_n = float_to_int(float=nf, rounding_mode="ROUND")
    ring_gable_field = input_named_attribute(name="g0", data_type="INT")
    has_active_gable = compare(
        a=attribute_statistic(
            geometry=ring,
            attribute=ring_gable_field * 1.0,
            data_type="FLOAT",
            domain="POINT",
        ).max,
        b=0.5,
        operation="GREATER_THAN",
    )

    @repeat_zone(iterations=wall_n)
    def fill_faces(
        arcsg: Geometry, ringg: Geometry, acc: Geometry, index: Integer
    ) -> tuple[Geometry, Geometry, Geometry]:
        k_f = index * 1.0
        al_w = input_named_attribute(name="al", data_type="FLOAT")
        ar_w = input_named_attribute(name="ar", data_type="FLOAT")
        sel_arc = boolean_math(
            boolean=compare(a=al_w, b=k_f, operation="EQUAL"),
            boolean_001=compare(a=ar_w, b=k_f, operation="EQUAL"),
            operation="OR",
        )
        wall_arcs = separate_geometry(geometry=arcsg, selection=sel_arc, domain="POINT")
        ea_pos = sample_index(
            geometry=ringg, value=input_position(), index=index,
            data_type="FLOAT_VECTOR", domain="POINT",
        )
        eb_f = sample_index(
            geometry=ringg,
            value=input_named_attribute(name="n0", data_type="FLOAT"),
            index=index,
            data_type="FLOAT", domain="POINT",
        )
        eb_i = float_to_int(float=eb_f, rounding_mode="ROUND")
        eb_pos = sample_index(
            geometry=ringg, value=input_position(), index=eb_i,
            data_type="FLOAT_VECTOR", domain="POINT",
        )
        pa_f = sample_index(
            geometry=ringg,
            value=input_named_attribute(name="p0", data_type="FLOAT"),
            index=index,
            data_type="FLOAT",
            domain="POINT",
        )
        pa_i = float_to_int(float=pa_f, rounding_mode="ROUND")
        pa_pos = sample_index(
            geometry=ringg, value=input_position(), index=pa_i,
            data_type="FLOAT_VECTOR", domain="POINT",
        )
        en_f = sample_index(
            geometry=ringg,
            value=input_named_attribute(name="n0", data_type="FLOAT"),
            index=eb_i,
            data_type="FLOAT",
            domain="POINT",
        )
        en_i = float_to_int(float=en_f, rounding_mode="ROUND")
        en_pos = sample_index(
            geometry=ringg, value=input_position(), index=en_i,
            data_type="FLOAT_VECTOR", domain="POINT",
        )
        ring_gable = input_named_attribute(name="g0", data_type="INT")
        current_gable = compare(
            a=sample_index(
                geometry=ringg, value=ring_gable, index=index,
                data_type="INT", domain="POINT",
            ),
            b=1,
            operation="EQUAL",
            data_type="INT",
        )
        previous_gable = compare(
            a=sample_index(
                geometry=ringg, value=ring_gable, index=pa_i,
                data_type="INT", domain="POINT",
            ),
            b=1,
            operation="EQUAL",
            data_type="INT",
        )
        next_gable = compare(
            a=sample_index(
                geometry=ringg, value=ring_gable, index=eb_i,
                data_type="INT", domain="POINT",
            ),
            b=1,
            operation="EQUAL",
            data_type="INT",
        )
        seg2 = mesh_line(
            count=2,
            start_location=(0.0, 0.0, 0.0),
            offset=(0.0, 0.0, 1.0),
            mode="OFFSET",
            count_mode="TOTAL",
        )
        wall_inst = instance_on_points(points=wall_arcs, instance=seg2)
        wall_real = realize_instances(geometry=wall_inst)
        par_w = math(value=input_index() * 1.0, value_001=2.0, operation="MODULO")
        use_b_w = compare(a=par_w, b=0.5, operation="GREATER_THAN")
        aa_w = input_named_attribute(name="aa", data_type="FLOAT_VECTOR")
        bb_w = input_named_attribute(name="bb", data_type="FLOAT_VECTOR")
        wpos = switch(switch=use_b_w, false=aa_w, true=bb_w, input_type="VECTOR")
        wall_seg = set_position(geometry=wall_real, position=wpos)
        eave_edge = mesh_line(
            count=2,
            start_location=ea_pos,
            offset=vector_math(vector=eb_pos, vector_001=ea_pos, operation="SUBTRACT"),
            mode="OFFSET",
            count_mode="TOTAL",
        )
        wall_all = join_geometry([wall_seg, eave_edge])
        wall_weld = merge_by_distance(
            geometry=wall_all, distance=weld_distance
        )
        wall_cur = mesh_to_curve(mesh=wall_weld)
        wall_cyc = set_spline_cyclic(curve=wall_cur, cyclic=True)
        wall_filled = fill_curve(curve=wall_cyc, mode="N-gons", fill_rule="Even-Odd")
        fill_position = input_position()
        at_eave_a = compare(
            a=vector_math(
                vector=fill_position, vector_001=ea_pos, operation="DISTANCE"
            ).value,
            b=weld_distance,
            operation="LESS_EQUAL",
        )
        at_eave_b = compare(
            a=vector_math(
                vector=fill_position, vector_001=eb_pos, operation="DISTANCE"
            ).value,
            b=weld_distance,
            operation="LESS_EQUAL",
        )
        at_source_endpoint = boolean_math(
            boolean=at_eave_a, boolean_001=at_eave_b, operation="OR"
        )
        reseat_endpoint = boolean_math(
            boolean=has_active_gable,
            boolean_001=at_source_endpoint,
            operation="AND",
        )
        exact_endpoint = switch(
            switch=at_eave_b, false=ea_pos, true=eb_pos, input_type="VECTOR"
        )
        wall_source_seated = set_position(
            geometry=wall_filled,
            selection=reseat_endpoint,
            position=exact_endpoint,
        )
        edge_vertices = input_mesh_edge_vertices()
        edge_a = edge_vertices.position_1
        edge_b = edge_vertices.position_2
        previous_line = vector_math(
            vector=ea_pos, vector_001=pa_pos, operation="SUBTRACT"
        )
        next_line = vector_math(
            vector=en_pos, vector_001=eb_pos, operation="SUBTRACT"
        )
        previous_tolerance = math(
            value=math(
                value=vector_math(
                    vector=previous_line, operation="LENGTH"
                ).value,
                value_001=1.0,
                operation="MAXIMUM",
            ),
            value_001=weld_distance,
            operation="MULTIPLY",
        )
        next_tolerance = math(
            value=math(
                value=vector_math(vector=next_line, operation="LENGTH").value,
                value_001=1.0,
                operation="MAXIMUM",
            ),
            value_001=weld_distance,
            operation="MULTIPLY",
        )
        previous_a_cross = separate_xyz(
            vector=vector_math(
                vector=previous_line,
                vector_001=vector_math(
                    vector=edge_a, vector_001=pa_pos, operation="SUBTRACT"
                ),
                operation="CROSS_PRODUCT",
            )
        ).z
        previous_b_cross = separate_xyz(
            vector=vector_math(
                vector=previous_line,
                vector_001=vector_math(
                    vector=edge_b, vector_001=pa_pos, operation="SUBTRACT"
                ),
                operation="CROSS_PRODUCT",
            )
        ).z
        next_a_cross = separate_xyz(
            vector=vector_math(
                vector=next_line,
                vector_001=vector_math(
                    vector=edge_a, vector_001=eb_pos, operation="SUBTRACT"
                ),
                operation="CROSS_PRODUCT",
            )
        ).z
        next_b_cross = separate_xyz(
            vector=vector_math(
                vector=next_line,
                vector_001=vector_math(
                    vector=edge_b, vector_001=eb_pos, operation="SUBTRACT"
                ),
                operation="CROSS_PRODUCT",
            )
        ).z
        on_previous_line = boolean_math(
            boolean=compare(
                a=math(value=previous_a_cross, operation="ABSOLUTE"),
                b=previous_tolerance,
                operation="LESS_EQUAL",
            ),
            boolean_001=compare(
                a=math(value=previous_b_cross, operation="ABSOLUTE"),
                b=previous_tolerance,
                operation="LESS_EQUAL",
            ),
            operation="AND",
        )
        on_next_line = boolean_math(
            boolean=compare(
                a=math(value=next_a_cross, operation="ABSOLUTE"),
                b=next_tolerance,
                operation="LESS_EQUAL",
            ),
            boolean_001=compare(
                a=math(value=next_b_cross, operation="ABSOLUTE"),
                b=next_tolerance,
                operation="LESS_EQUAL",
            ),
            operation="AND",
        )
        is_verge = boolean_math(
            boolean=boolean_math(
                boolean=previous_gable,
                boolean_001=on_previous_line,
                operation="AND",
            ),
            boolean_001=boolean_math(
                boolean=next_gable,
                boolean_001=on_next_line,
                operation="AND",
            ),
            operation="OR",
        )
        wall_verge = store_named_attribute(
            geometry=wall_source_seated,
            name="gn_roof_edge_class",
            value=switch(
                switch=is_verge, false=0, true=5, input_type="INT"
            ),
            data_type="INT",
            domain="EDGE",
        )
        lav_f = sample_index(
            geometry=ringg,
            value=input_named_attribute(name="lav0", data_type="FLOAT"),
            index=index,
            data_type="FLOAT",
            domain="POINT",
        )
        ed_f = sample_index(
            geometry=ringg,
            value=input_named_attribute(name="ed0", data_type="FLOAT"),
            index=index,
            data_type="FLOAT",
            domain="POINT",
        )
        lav_i = float_to_int(float=lav_f, rounding_mode="ROUND")
        ed_i = float_to_int(float=ed_f, rounding_mode="ROUND")
        wall_component = store_named_attribute(
            geometry=wall_verge,
            name="gn_component_id", value=0,
            data_type="INT", domain="FACE",
        )
        wall_contour = store_named_attribute(
            geometry=wall_component,
            name="gn_contour_id", value=lav_i,
            data_type="INT", domain="FACE",
        )
        wall_source = store_named_attribute(
            geometry=wall_contour,
            name="gn_source_boundary_id", value=ed_i,
            data_type="INT", domain="FACE",
        )
        wall_face = store_named_attribute(
            geometry=wall_source,
            name="gn_roof_face_id", value=ed_i,
            data_type="INT", domain="FACE",
        )
        wall_class = store_named_attribute(
            geometry=wall_face,
            name="gn_roof_face_class", value=1,
            data_type="INT", domain="FACE",
        )
        wall_identity = store_named_attribute(
            geometry=wall_class,
            name="gn_identity_stable", value=identity_stable,
            data_type="BOOLEAN", domain="FACE",
        )
        wall_kept = switch(
            switch=current_gable,
            false=wall_identity,
            true=points(count=0),
            input_type="GEOMETRY",
        )
        acc_next = join_geometry([acc, wall_kept])
        return arcsg, ringg, acc_next

    _arcs_kept, _ring_kept, roof_flat = fill_faces(
        arcs_end, ring, points(count=0)
    )
    near_i = sample_nearest(
        geometry=face_pts, sample_position=input_position(), domain="POINT"
    )
    near_z = sample_index(
        geometry=face_pts,
        value=input_named_attribute(name="pz", data_type="FLOAT"),
        index=near_i,
        data_type="FLOAT",
        domain="POINT",
    )
    rf_xyz = separate_xyz(vector=input_position())
    roof_mesh = set_position(
        geometry=roof_flat, position=(rf_xyz.x, rf_xyz.y, near_z)
    )
    return roof_mesh


@node_tree(id="opus.gnslice.roof_semantics.v1", target="geometry")
def skel_roof_semantics(
    roof_mesh: Geometry,
    weld_distance: Float,
) -> Geometry:
    """Preserve plan time, gable VERGEs, and exactly provable eave edges."""
    xyz = separate_xyz(vector=input_position())
    plan_stamped = store_named_attribute(
        geometry=roof_mesh,
        name="gn_plan_t",
        value=xyz.z,
        data_type="FLOAT",
        domain="POINT",
    )
    endpoints = input_mesh_edge_vertices()
    t1 = separate_xyz(vector=endpoints.position_1).z
    t2 = separate_xyz(vector=endpoints.position_2).z
    t1_zero = compare(
        a=math(value=t1, operation="ABSOLUTE"),
        b=weld_distance,
        operation="LESS_EQUAL",
    )
    t2_zero = compare(
        a=math(value=t2, operation="ABSOLUTE"),
        b=weld_distance,
        operation="LESS_EQUAL",
    )
    is_eave = boolean_math(
        boolean=t1_zero, boolean_001=t2_zero, operation="AND"
    )
    ordinary_edge_class = switch(
        switch=is_eave, false=0, true=1, input_type="INT"
    )
    existing_edge_class = input_named_attribute(
        name="gn_roof_edge_class", data_type="INT"
    )
    is_verge = compare(
        a=existing_edge_class, b=5, operation="EQUAL", data_type="INT"
    )
    edge_class = switch(
        switch=is_verge, false=ordinary_edge_class, true=5, input_type="INT"
    )
    classified = store_named_attribute(
        geometry=plan_stamped,
        name="gn_roof_edge_class",
        value=edge_class,
        data_type="INT",
        domain="EDGE",
    )
    return remove_attribute(
        geometry=classified, pattern_mode="Wildcard", name="g0*"
    )


@node_tree(id="opus.gnslice.height.v1", target="geometry")
def skel_height(
    roof_mesh: Geometry,
    pitch_deg: Float,
    eave_z: Float,
) -> Geometry:
    """Apply the affine roof-height law after topology and face emission."""
    xyz = separate_xyz(vector=input_position())
    pitch_rad = math(value=pitch_deg, operation="RADIANS")
    slope = math(value=pitch_rad, operation="TANGENT")
    rise = math(value=xyz.z, value_001=slope, operation="MULTIPLY")
    height = math(value=eave_z, value_001=rise, operation="ADD")
    return set_position(
        geometry=roof_mesh,
        position=(xyz.x, xyz.y, height),
    )


@node_tree(id="opus.gnslice.carrier.v1", target="geometry")
def state_carrier(
    has_err: Boolean, code_f: Float,
    it: Float, tn: Float, bc: Float,
    d_a: Vector, d_b: Vector, d_c: Vector,
    d_d: Vector, d_e: Vector, d_f: Vector,
) -> Geometry:
    """Contract S6.4 carrier(): THE one-point State error carrier (A4/D3).
    One mesh vertex -- mesh_line(count=1), because a points() cloud
    vanishes under modifier-to-mesh evaluation (measured verts=0/no attrs;
    backlog entry 22 lineage) -- carrying the retained solve_error alias,
    gn_error, gn_error_code
    (Int), gn_iterations/gn_tnow/gn_births and the six gd gate vectors
    gn_gate_a..f. The old good_*/fail_*/code8_* triple chains (3x 14
    stores) collapse into this one def; call sites hand in switch-selected
    values, so exactly one (code, state) combination reaches the output
    while the node count drops to 12 stores total.
    """
    pt = mesh_line(
        count=1,
        start_location=(0.0, 0.0, 0.0),
        offset=(0.0, 0.0, 1.0),
        mode="OFFSET",
        count_mode="TOTAL",
    )
    s_se = store_named_attribute(
        geometry=pt, name="solve_error", value=has_err,
        data_type="BOOLEAN", domain="POINT",
    )
    s_ge = store_named_attribute(
        geometry=s_se, name="gn_error", value=has_err,
        data_type="BOOLEAN", domain="POINT",
    )
    s_ec = store_named_attribute(
        geometry=s_ge, name="gn_error_code",
        value=float_to_int(float=code_f, rounding_mode="ROUND"),
        data_type="INT", domain="POINT",
    )
    s_it = store_named_attribute(
        geometry=s_ec, name="gn_iterations", value=it,
        data_type="FLOAT", domain="POINT",
    )
    s_tn = store_named_attribute(
        geometry=s_it, name="gn_tnow", value=tn,
        data_type="FLOAT", domain="POINT",
    )
    s_bc = store_named_attribute(
        geometry=s_tn, name="gn_births", value=bc,
        data_type="FLOAT", domain="POINT",
    )
    s_ga = store_named_attribute(
        geometry=s_bc, name="gn_gate_a", value=d_a,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    s_gb = store_named_attribute(
        geometry=s_ga, name="gn_gate_b", value=d_b,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    s_gc = store_named_attribute(
        geometry=s_gb, name="gn_gate_c", value=d_c,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    s_gd = store_named_attribute(
        geometry=s_gc, name="gn_gate_d", value=d_d,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    s_gate_e = store_named_attribute(
        geometry=s_gd, name="gn_gate_e", value=d_e,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    s_gf = store_named_attribute(
        geometry=s_gate_e, name="gn_gate_f", value=d_f,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    return s_gf


@node_tree(id="opus.gnslice.report.v1", target="geometry")
def skel_report(
    front_end: Geometry,
    arcs_end: Geometry,
    roof_mesh: Geometry,
    solve_origin_z: Float,
    cp_f: Float,
    it_end: Float,
    t_end: Float,
    bc_end: Float,
    ec_end: Float,
    w8_bad: Boolean,
    c9_bad: Boolean,
    c1_bad: Boolean,
    emit_skeleton: Boolean = True,
) -> Geometry:
    """Post-solve report (structural steps 19 + 22/S6.4): gd diagnostic
    exit reads, skeleton arc evidence geometry, and the ONE-point State
    carrier (state_carrier.v1: ok code-0 / codes 1-7 / code-8 input
    validation selected by switch, replacing the old three chains).
    Step-19 body byte-verbatim; only binding-site renames
    (_front_end->front_end, _t_end->t_end, _bc_end->bc_end — the _d_*
    locals keep their names, they have consumers). err_end is computed
    here from the ec_end param.

    Phase-2c (emit_skeleton, contract S6.7): False strips the arc
    evidence network from the joined output. The evidence chain stamps a
    dedicated `evk` marker AFTER realize/set_position; selection is
    VALUE-level (evk > 0.5), never `.exists` — Join Geometry unifies
    attribute domains across inputs, so any attribute present on one
    branch exists on the whole joined mesh with default-filled values.
    Evidence verts are deleted only when evk>0.5 AND NOT emit_skeleton.
    """
    # D1-sweep gate counters ride the front as attributes (repeat_zone state
    # arity is fixed; attributes carry for free). Frozen-state livelocks
    # repeat one iteration forever, so the EXIT iteration's counters
    # diagnose every stuck iteration.
    _d_base = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd1", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_prec = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd2", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_pre = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd3", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_fin = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd4", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_dvx = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd5", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_dvy = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd6", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_dva = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd7", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_sita = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd8", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_nacc = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd9", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_sx = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd10", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_sy = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd11", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_wx = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd12", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_wy = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd13", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_cn = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd14", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    _d_cx = sample_index(
        geometry=front_end, value=input_named_attribute(name="gd15", data_type="FLOAT"),
        index=0, data_type="FLOAT", domain="POINT",
    )
    err_end = compare(a=ec_end, b=0.5, operation="GREATER_THAN")

    # ---------- skeleton arc evidence geometry -----------------------------
    is_cap = compare(a=cp_f, b=0.5, operation="GREATER_THAN")
    is_ridge2 = compare(a=cp_f, b=1.5, operation="GREATER_THAN")
    not_ridge2 = boolean_math(boolean=is_ridge2, operation="NOT")
    drop_ev = boolean_math(boolean=is_cap, boolean_001=not_ridge2, operation="AND")
    arc_seeds = delete_geometry(
        geometry=arcs_end, selection=drop_ev, mode="ALL", domain="POINT"
    )
    seg = mesh_line(
        count=2,
        start_location=(0.0, 0.0, 0.0),
        offset=(0.0, 0.0, 1.0),
        mode="OFFSET",
        count_mode="TOTAL",
    )
    arc_inst = instance_on_points(points=arc_seeds, instance=seg)
    arc_real = realize_instances(geometry=arc_inst)
    parity = math(value=input_index() * 1.0, value_001=2.0, operation="MODULO")
    use_b = compare(a=parity, b=0.5, operation="GREATER_THAN")
    aa_r = input_named_attribute(name="aa", data_type="FLOAT_VECTOR")
    bb_r = input_named_attribute(name="bb", data_type="FLOAT_VECTOR")
    arc_pos = switch(switch=use_b, false=aa_r, true=bb_r, input_type="VECTOR")
    arc_geo = set_position(geometry=arc_real, position=arc_pos)
    arc_class = input_named_attribute(
        name="k3_skeleton_arc_class", data_type="INT"
    )
    arc_left = input_named_attribute(
        name="k3_left_roof_face_id", data_type="INT"
    )
    arc_right = input_named_attribute(
        name="k3_right_roof_face_id", data_type="INT"
    )
    arc_semantic_class = store_named_attribute(
        geometry=arc_geo,
        name="gn_skeleton_arc_class",
        value=arc_class,
        data_type="INT",
        domain="EDGE",
    )
    arc_semantic_left = store_named_attribute(
        geometry=arc_semantic_class,
        name="gn_left_roof_face_id",
        value=arc_left,
        data_type="INT",
        domain="EDGE",
    )
    arc_semantic_right = store_named_attribute(
        geometry=arc_semantic_left,
        name="gn_right_roof_face_id",
        value=arc_right,
        data_type="INT",
        domain="EDGE",
    )
    arc_xyz = separate_xyz(vector=input_position())
    arc_plan_t = math(
        value=arc_xyz.z, value_001=solve_origin_z, operation="SUBTRACT"
    )
    arc_semantic_t = store_named_attribute(
        geometry=arc_semantic_right,
        name="gn_plan_t",
        value=arc_plan_t,
        data_type="FLOAT",
        domain="POINT",
    )
    # Phase-2c discriminator: evidence-only marker stamped AFTER the
    # realize/set_position chain. `aa` propagates through realize ->
    # set_position -> skel_faces' fill_curve onto ROOF verts too, so it is
    # NOT a valid selector (probe_emit_tap caught the whole roof deleted);
    # only points stamped here carry `evk`.
    ev_marked = store_named_attribute(
        geometry=arc_semantic_t, name="evk", value=1.0, data_type="FLOAT",
        domain="POINT",
    )

    good = join_geometry([roof_mesh, ev_marked])
    # A4/D3 + S6.4: the error contract lives on ONE State point built by
    # state_carrier() (mesh_line idiom -- points() clouds vanish under
    # to_mesh); the three outcome branches become switch-selected values on
    # that single carrier below (code0-with-roof / codes 1-7 / code-8 input
    # validation), replacing the former triplicated 14-store chains.
    # Outcome branches become switch-selected values on the ONE carrier
    # point (S6.4): w8_bad selects the code-8 input-validation state
    # outright; otherwise the solve's own exit values flow through
    # unchanged and success writes the explicit code-0 claim.
    pre_bad = boolean_math(boolean=c9_bad, boolean_001=c1_bad, operation="OR")
    err_or_w8 = boolean_math(boolean=err_end, boolean_001=w8_bad, operation="OR")
    any_err = boolean_math(boolean=err_or_w8, boolean_001=pre_bad, operation="OR")
    code_sel = switch(
        c9_bad,
        false=switch(
            c1_bad,
            false=switch(
                w8_bad,
                false=switch(err_end, false=0.0, true=ec_end),
                true=8.0,
            ),
            true=1.0,
        ),
        true=9.0,
    )
    input_bad = boolean_math(boolean=w8_bad, boolean_001=pre_bad, operation="OR")
    it_sel = switch(input_bad, false=it_end, true=0.0)
    tn_sel = switch(input_bad, false=t_end, true=0.0)
    bc_sel = switch(input_bad, false=bc_end, true=0.0)
    ga_real = combine_xyz(x=_d_base, y=_d_prec, z=_d_pre)
    gb_real = combine_xyz(x=_d_fin, y=_d_dvx, z=_d_dvy)
    gc_real = combine_xyz(x=_d_dva, y=_d_sita, z=0.0)
    gd_real = combine_xyz(x=_d_nacc, y=_d_sx, z=_d_sy)
    ge_real = combine_xyz(x=_d_wx, y=_d_wy, z=0.0)
    gf_real = combine_xyz(x=_d_cn, y=_d_cx, z=0.0)
    gate_zero = combine_xyz(x=0.0, y=0.0, z=0.0)
    ga_sel = switch(input_bad, false=ga_real, true=gate_zero,
                    input_type="VECTOR")
    gb_sel = switch(input_bad, false=gb_real, true=gate_zero,
                    input_type="VECTOR")
    gc_sel = switch(input_bad, false=gc_real, true=gate_zero,
                    input_type="VECTOR")
    gd_sel = switch(input_bad, false=gd_real, true=gate_zero,
                    input_type="VECTOR")
    ge_sel = switch(input_bad, false=ge_real, true=gate_zero,
                    input_type="VECTOR")
    gf_sel = switch(input_bad, false=gf_real, true=gate_zero,
                    input_type="VECTOR")
    state_geo = state_carrier(
        has_err=any_err, code_f=code_sel, it=it_sel, tn=tn_sel, bc=bc_sel,
        d_a=ga_sel, d_b=gb_sel, d_c=gc_sel,
        d_d=gd_sel, d_e=ge_sel, d_f=gf_sel,
    )
    # Roof joins the output only on success (unchanged behavior); the State
    # carrier always joins it (exactly one point, code-0 claim on success).
    # rung 3a: a tripped input validation (w8_bad, computed pre-solve at S2)
    # suppresses the solved output; its code-8 values win every switch above.
    # Phase-2c: emit_skeleton=False also strips the arc evidence network
    # (verts where the evidence-only `evk` marker > 0.5). Selection is
    # VALUE-level, never existence-level: Join Geometry unifies attribute
    # domains across its inputs, so any named attribute present on one
    # branch exists on the WHOLE joined mesh (default 0.0 elsewhere) —
    # `.exists` is therefore always true post-join. Probe receipts: aa+
    # .exists wiped the whole roof twice (probe_emit_tap RED x2).
    not_emit = boolean_math(boolean=emit_skeleton, operation="NOT")
    evk_here = input_named_attribute(name="evk", data_type="FLOAT")
    strip_marked = compare(a=evk_here, b=0.5, operation="GREATER_THAN")
    kill_ev = boolean_math(
        boolean=strip_marked, boolean_001=not_emit, operation="AND"
    )
    out_sel = boolean_math(
        boolean=any_err, boolean_001=kill_ev, operation="OR"
    )
    ok_roof = delete_geometry(
        geometry=good, selection=out_sel, mode="ALL", domain="POINT"
    )
    return join_geometry([ok_roof, state_geo])


@node_tree(id="opus.gnslice.roof.v1", target="geometry")
def roof(
    outline: Geometry,
    # --- public interface (contract S2 opus surface; phase 1 inert carried
    # the old wiring; phase 2 moves defaults to their designed values) ------
    #   max_events=64   : solve-zone budget headroom above the N+(N-2) pool
    #                     envelope of the supported input window (every
    #                     current fixture converges <= 15).
    #   chase_depth     = both chase walk bounds (was coupled to maxiter;
    #                     phase 1 decoupled by NAME; phase-2 retarget is its
    #                     own commit).
    #   max_split_pairs: declared knob; clamp sits above any fixture m*n.
    #   emit_skeleton: phase-2c CONSUMER LANDED in skel_report — evidence
    #                     network join is stripped when False (the default:
    #                     roof-only output; True restores the arc wireframe).
    #   debug: phase-2d CONSUMER LANDED in the solve zone's gd store chain —
    #                     False (default) zeroes every diagnostic counter;
    #                     True restores live counters with no rebuild. The
    #                     stores themselves remain compiled (leaf topology:
    #                     only deliberately-dead `_d_*` report readers exist).
    max_events: Integer = 64,
    chase_depth: Integer = 16,
    max_split_pairs: Integer = 4096,
    weld_distance: Float = 0.00001,
    emit_skeleton: Boolean = False,
    debug: Boolean = False,
    # Appended after existing controls so same-id rebuilds retain their socket
    # identifiers. The 45/0 defaults preserve the accepted z=t roof.
    PitchDeg: Float = 45.0,
    EaveZ: Float = 0.0,
    FlatTop: Boolean = False,
    MaxRise: Float = 1.0,
    FlatBottom: Boolean = False,
    MaxDrop: Float = 1.0,
) -> Geometry:
    # ---------- S1: ordered corner ring (extracted step 14) ------------------
    ring, ring_w, mesh_w, nf, ndom, c9_bad, c1_bad, canonical = skel_ring(
        outline=outline,
        max_split_pairs=max_split_pairs,
        weld_distance=weld_distance,
    )
    adapter_ok = boolean_math(
        boolean=boolean_math(
            boolean=c9_bad, boolean_001=c1_bad, operation="OR"
        ),
        operation="NOT",
    )
    terminal_ring = switch(
        switch=adapter_ok, false=points(count=0), true=ring,
        input_type="GEOMETRY",
    )
    terminal_mesh_w = switch(
        switch=adapter_ok, false=points(count=0), true=mesh_w,
        input_type="GEOMETRY",
    )
    terminal_nf = switch(
        switch=adapter_ok, false=0.0, true=nf, input_type="FLOAT"
    )
    terminal_ndom = switch(
        switch=adapter_ok, false=0, true=ndom, input_type="INT"
    )
    terminal_events = switch(
        switch=adapter_ok, false=0, true=max_events, input_type="INT"
    )

    # P1-T12: run the numeric solver in a contour-local frame while leaving
    # the adapter's semantic rows in their authored world coordinates.  The
    # first normalized row is deterministic; subtracting it before front
    # initialization makes every event predicate depend on local differences
    # instead of world-origin magnitude.  S8 and emitted arc endpoints are
    # translated back below, before the report joins user-visible geometry.
    solve_origin = sample_index(
        geometry=terminal_ring,
        value=input_position(),
        index=0,
        data_type="FLOAT_VECTOR",
        domain="POINT",
    )
    solver_ring = set_position(
        geometry=terminal_ring,
        position=vector_math(
            vector=input_position(), vector_001=solve_origin,
            operation="SUBTRACT",
        ),
    )

    # ---------- S2a: front initialisation (extracted step 15) ---------------
    front_live, idx_f, pos_j, edge_in, edge_dir, w_in, sep_c_z = skel_front_init(
        ring=solver_ring, ring_w=ring_w, nf=terminal_nf
    )

    # ---- rung-3a input validation (extracted step 16) ----------------------
    w8_bad = skel_validate(
        mesh_w=terminal_mesh_w,
        front_live=front_live,
        ring_w=ring_w,
        w_in=w_in,
        pos_j=pos_j,
        edge_in=edge_in,
        edge_dir=edge_dir,
        sep_c_z=sep_c_z,
    )
    pitch_rad = math(value=PitchDeg, operation="RADIANS")
    pitch_slope = math(value=pitch_rad, operation="TANGENT")
    pitch_magnitude = math(value=pitch_slope, operation="ABSOLUTE")
    pitch_up = compare(a=pitch_slope, b=0.0, operation="GREATER_THAN")
    pitch_down = compare(a=0.0, b=pitch_slope, operation="GREATER_THAN")
    top_magnitude_bad = boolean_math(
        boolean=FlatTop,
        boolean_001=compare(
            a=MaxRise, b=weld_distance, operation="LESS_EQUAL"
        ),
        operation="AND",
    )
    bottom_magnitude_bad = boolean_math(
        boolean=FlatBottom,
        boolean_001=compare(
            a=MaxDrop, b=weld_distance, operation="LESS_EQUAL"
        ),
        operation="AND",
    )
    any_cap = boolean_math(
        boolean=FlatTop, boolean_001=FlatBottom, operation="OR"
    )
    direction_nonzero = boolean_math(
        boolean=pitch_up, boolean_001=pitch_down, operation="OR"
    )
    zero_pitch_bad = boolean_math(
        boolean=any_cap,
        boolean_001=boolean_math(boolean=direction_nonzero, operation="NOT"),
        operation="AND",
    )
    cap_input_bad = boolean_math(
        boolean=top_magnitude_bad,
        boolean_001=boolean_math(
            boolean=bottom_magnitude_bad,
            boolean_001=zero_pitch_bad,
            operation="OR",
        ),
        operation="OR",
    )
    top_on = boolean_math(
        boolean=FlatTop, boolean_001=pitch_up, operation="AND"
    )
    bottom_on = boolean_math(
        boolean=FlatBottom, boolean_001=pitch_down, operation="AND"
    )
    cap_on = boolean_math(
        boolean=top_on, boolean_001=bottom_on, operation="OR"
    )
    cap_magnitude = switch(
        switch=top_on, false=MaxDrop, true=MaxRise, input_type="FLOAT"
    )
    w8_all = boolean_math(
        boolean=w8_bad,
        boolean_001=cap_input_bad,
        operation="OR",
    )
    safe_slope = switch(
        switch=cap_input_bad, false=pitch_magnitude, true=1.0, input_type="FLOAT"
    )
    t_cap = math(
        value=cap_magnitude, value_001=safe_slope, operation="DIVIDE"
    )

    # ---- A1 multi-LAV record pool (extracted step 17) -----------------------
    front0, arcs0, pool_n = skel_pool(
        nf=terminal_nf, ndom=terminal_ndom, idx_f=idx_f, front_live=front_live
    )

    # ---------- S3..S7: the solve ------------------------------------------
    @repeat_zone(iterations=terminal_events)
    def solve(
        front: Geometry,
        arcs: Geometry,
        tnow: Float,
        done: Boolean,
        ec: Float,
        it: Float,
        bc: Float,
        lc: Float,
        capped: Boolean,
        index: Integer,
    ) -> tuple[Geometry, Geometry, Float, Boolean, Float, Float, Float, Float, Boolean]:
        z_idx = input_index() * 1.0
        lv_f = input_named_attribute(name="lv", data_type="FLOAT")
        ap_f = input_named_attribute(name="ap", data_type="FLOAT_VECTOR")
        at_f = input_named_attribute(name="at", data_type="FLOAT")
        vl_f = input_named_attribute(name="vl", data_type="FLOAT_VECTOR")
        nr_f = input_named_attribute(name="nr", data_type="FLOAT_VECTOR")
        nx_f = input_named_attribute(name="nx", data_type="FLOAT")
        pv_f = input_named_attribute(name="pv", data_type="FLOAT")
        ed_f = input_named_attribute(name="ed", data_type="FLOAT")
        lav_f = input_named_attribute(name="lav", data_type="FLOAT")
        w_f = input_named_attribute(name="w", data_type="FLOAT")
        alive = compare(a=lv_f, b=0.5, operation="GREATER_THAN")
        # Pin this slot's OWN old-gen nx. nx_f is an unpinned read, so any
        # store further down the rebuild chain re-evaluates it against the
        # NEW chain state (store-order law, rebuild docstring). Measured fx3:
        # at the td store, slot 0's post-split nx=6 indexed the OLD padding
        # slot 6, whose default nx=0 collided with slot 0 -> phantom ring2
        # -> td=1 at iteration 1. A self-sample onto the zone-input front
        # pins every first-hop read to the old generation.
        z_i = float_to_int(float=z_idx, rounding_mode="ROUND")
        nx_o = sample_index(
            geometry=front, value=nx_f, index=z_i, data_type="FLOAT", domain="POINT"
        )
        nx_i = float_to_int(float=nx_o, rounding_mode="ROUND")
        pv_i = float_to_int(float=pv_f, rounding_mode="ROUND")

        # A3 per-ring cycle tests (hops sample-pinned to the zone-input
        # front, the OLD generation, like every S3 hop): 2-ring i<->nx[i];
        # 3-ring i->a->b->i with self/2-hop guards; 2-ring leader = lower
        # birth order (oracle frm; bo unique — slot ids now, ranks later).
        bo_f = input_named_attribute(name="bo", data_type="FLOAT")
        nx2_f = sample_index(
            geometry=front, value=nx_f, index=nx_i, data_type="FLOAT", domain="POINT"
        )
        self_b = compare(a=nx_o, b=z_idx, operation="EQUAL")
        not_self = boolean_math(boolean=self_b, operation="NOT")
        nx2self = compare(a=nx2_f, b=z_idx, operation="EQUAL")
        ring2_b = boolean_math(
            boolean=boolean_math(boolean=alive, boolean_001=not_self, operation="AND"),
            boolean_001=nx2self,
            operation="AND",
        )
        bo_nx = sample_index(
            geometry=front, value=bo_f, index=nx_i, data_type="FLOAT", domain="POINT"
        )
        bo_lead = compare(a=bo_f, b=bo_nx, operation="LESS_THAN")
        is_leader = boolean_math(boolean=ring2_b, boolean_001=bo_lead, operation="AND")

        nlive = attribute_statistic(
            geometry=front,
            selection=alive,
            attribute=1.0,
            data_type="FLOAT",
            domain="POINT",
        ).sum

        # --- S3 candidate recompute (every live edge, every iteration) -----
        # Extracted to skel_collapse (structural revision S6 step 1,
        # 2026-08-26): pure field math, no stores; interface
        # {front, ap, at, vl, alive, nx_i, tnow} -> cand. The
        # freshness-band rationale comment moved with the code.
        cand_raw, meet_b = skel_collapse(
            front=front, ap=ap_f, at=at_f, vl=vl_f, alive=alive, nx_i=nx_i, tnow=tnow
        )

        # --- S7a-I split scan: pair cloud -> per-reflex argmin (P11) -------
        # Ranked clouds (ascending slot id; ranks address by index math —
        # compaction after delete preserves order, and slot ids ride as
        # POSITION so nothing depends on attributes surviving the curve).
        (
            s_st, t_min_s, arg_r, arg_a, sw_s_c, sw_cls, sw_b_f, sw_pv_a_f,
            sw_pv_r_f, sw_nx_r_f, sw_A_nx, sw_lav_r, sw_lav_a, sw_detA,
            sw_detB,
        ) = skel_split_scan(
            front=front, alive=alive, z_idx=z_idx, nlive=nlive, tnow=tnow
        )
        # K1: a closest-approach edge row that does not actually meet is not
        # allowed to pre-empt a co-band split. Hide only that row for this
        # iteration; no state or event class is added, so D1 re-admits it on
        # the next iteration when the split is no longer in the tie band.
        defer_row = boolean_math(
            boolean=boolean_math(boolean=meet_b, operation="NOT"),
            boolean_001=compare(
                a=t_min_s,
                b=cand_raw * 1.00001,
                operation="LESS_EQUAL",
            ),
            operation="AND",
        )
        cand = switch(
            switch=defer_row,
            false=cand_raw,
            true=1000000000.0,
            input_type="FLOAT",
        )

        # --- S4 global next event + co-height batch ------------------------
        t_min_e = attribute_statistic(
            geometry=front,
            selection=alive,
            attribute=cand,
            data_type="FLOAT",
            domain="POINT",
        ).min
        t_min = math(value=t_min_e, value_001=t_min_s, operation="MINIMUM")
        (
            f_sm, f_dy, f_sdy, no_event, amb5_e, total_col, tie_thr, ce_f2,
            ce_b2, dying, not_cep, sm_f, hd_f, dy_f, sdy_sm_f, sdy_hd_f, pv_fa,
        ) = skel_edge_batch(
            front=front, alive=alive, cand=cand, t_min=t_min,
            nlive=nlive, maxiter=chase_depth, pv_i=pv_i,
        )

        # --- S7a-II site acceptance + dispatch data (P11) -------------------
        # A site dispatches when base-valid, inside the GLOBAL tie band, not
        # superseded by the edge batch (r dead, or the hit edge's own two
        # endpoints merging — the oracle's r.alive/e.alive guard), not
        # cross-LAV (code 6), not det-degenerate
        # (code 4), and the B-slot allocation fits the pool (code 1).
        (
            srk, srk_pts, N_f, any_site, cap_ok, n_acc, n_acc_i, n_acc_pre,
            pre_core, det_bad, det_ok, xlav_b, amb5_s_row, dbg_b, dbg_c,
            n_acc_dbg, site_a_s, site_x_s, site_y_s, win_a_s, win_x_s,
            win_y_s, cloud_n_s, cloud_x_s,
        ) = skel_arbitrate(
            front=front, s_st=s_st, arg_r=arg_r, arg_a=arg_a,
            sw_s_c=sw_s_c, sw_cls=sw_cls, sw_b_f=sw_b_f, sw_pv_a_f=sw_pv_a_f,
            sw_pv_r_f=sw_pv_r_f, sw_nx_r_f=sw_nx_r_f, sw_a_nx=sw_A_nx,
            sw_lav_a=sw_lav_a, sw_deta=sw_detA,
            sw_detb=sw_detB, f_sm=f_sm, f_dy=f_dy, f_sdy=f_sdy,
            ce_f2=ce_f2, dy_f=dy_f, sdy_hd_f=sdy_hd_f, pv_fa=pv_fa,
            tie_thr=tie_thr, bc=bc, z_idx=z_idx,
        )

        # Killed cloud: r (always) and the at-u/at-w endpoint, keyed by slot;
        # y carries the site's own s (pool-side death positions use it, not
        # global t_min — co-band events each land at their own time).
        dying_sp, dying_r, sp_time = skel_kill(
            front=front, srk=srk, n_acc_i=n_acc_i, z_idx=z_idx,
            tnow=tnow, any_site=any_site,
        )

        # Patch cloud: 6 survivor-rewrite roles per site (oracle _do_split
        # pointer surgery, gathered keyed by target slot): r0 (u.nx),
        # r1 (w.pv), r2 (pv_u.nx), r3 (nx_r.pv), r4 (pv_r.nx), r5 (nx_b.pv).
        # Position = (target, new_nx, new_pv); -1 marks "not this branch".
        p_nx_ok, p_pv_ok, p_nx_val, p_pv_val = skel_patch(
            front=front, srk=srk, n_acc_i=n_acc_i, z_idx=z_idx,
            tnow=tnow, any_site=any_site, n_f=N_f, bc=bc,
            f_dy=f_dy, f_sdy=f_sdy, dy_f=dy_f, sdy_hd_f=sdy_hd_f,
        )

        # Pool-side newborn lookups: A keyed by r_slot, B by B_slot
        # (= N + bc + rank, stamped as the keyed copy's own position).
        # a_a_x/a_a_y/a_b_x/a_b_y = asepA/asepB components (the def returns
        # scalars; group outputs do not resolve attribute access).
        is_A, is_B, iA, iB, a_a_x, a_a_y, a_b_x, a_b_y = skel_newborn_keys(
            srk_pts=srk_pts, srk=srk, z_idx=z_idx, any_site=any_site, n_f=N_f, bc=bc,
        )

        # Site-side death arcs (uarc/warc): see skel_site_arcs docstring.
        uarc, warc = skel_site_arcs(
            front=front, srk=srk, n_acc_i=n_acc_i, z_idx=z_idx,
            tnow=tnow, ap_f=ap_f, at_f=at_f,
        )

        # --- S6 arc emission (one record per dying vertex) -----------------
        e6, arc_a, ed_prv, nd_c, t_ev, p_death, zero_dur = skel_ev_arcs(
            f_sm=f_sm, t_min=t_min, sp_time=sp_time, dying_sp=dying_sp,
            ap_f=ap_f, at_f=at_f, vl_f=vl_f, ed_f=ed_f, ce_b2=ce_b2,
            pv_f=pv_f, nx_o=nx_o, z_i=z_i, pv_i=pv_i, z_it=index,
        )
        # --- S5 immutable rebuild ------------------------------------------
        (
            not_dying_all, is_head, nr_sm, nr_prv, pv_hd,
            lv_new, ap_new, at_new, vl_new, nr_new, ed_new, nx_new, w_new,
        ) = skel_rebase(
            f_sm=f_sm, sm_f=sm_f, ce_b2=ce_b2, not_cep=not_cep,
            nx_f=nx_f, nr_f=nr_f, ed_f=ed_f, pv_i=pv_i, hd_f=hd_f, w_f=w_f,
            dying=dying, dying_sp=dying_sp, alive=alive, nd_c=nd_c,
            p_death=p_death, t_ev=t_ev, t_min=t_min,
            ap_f=ap_f, at_f=at_f, vl_f=vl_f,
        )

        # --- S7 per-ring termination: caps + one ridge per 2-ring ----------
        caps, ridge, td_new_v, td_f, not_done = skel_caps(
            f_sm=f_sm, nx_i=nx_i, ap_f=ap_f, at_f=at_f, ed_f=ed_f,
            arc_a=arc_a, ed_prv=ed_prv, ring2_b=ring2_b, done=done,
            is_leader=is_leader, z_it=index,
        )
        # --- branch select + fold (S5) via skel_fold ----------------------
        front_rebuilt, arcs_out, is_ba, lav_B, cross_merge = skel_fold(
            done=done, ring2_b=ring2_b, dying=dying, dying_r=dying_r,
            zero_dur=zero_dur,
            e6=e6, arcs=arcs, caps=caps, ridge=ridge, uarc=uarc, warc=warc,
            is_a=is_A, is_b=is_B, ia=iA, ib=iB,
            a_a_x=a_a_x, a_a_y=a_a_y, a_b_x=a_b_x, a_b_y=a_b_y,
            front=front, tnow=tnow, f_dy=f_dy, dy_f=dy_f, f_sdy=f_sdy,
            sdy_hd_f=sdy_hd_f,
            bc=bc, lc=lc, n_acc=n_acc,
            nr_sm=nr_sm, nr_prv=nr_prv, bo_f=bo_f, lav_f=lav_f, lv_f=lv_f,
            is_head=is_head, lv_new=lv_new, ap_new=ap_new, at_new=at_new,
            vl_new=vl_new, nr_new=nr_new, ed_new=ed_new, nx_new=nx_new,
            w_new=w_new, p_nx_ok=p_nx_ok, p_nx_val=p_nx_val,
            p_pv_ok=p_pv_ok, p_pv_val=p_pv_val, pv_hd=pv_hd,
            ap_f=ap_f, at_f=at_f, vl_f=vl_f, nr_f=nr_f, ed_f=ed_f,
            w_f=w_f, nx_f=nx_f, pv_f=pv_f, td_new_v=td_new_v, td_f=td_f,
            f_sm=f_sm,
        )

        # LAV re-stamp (task #6): a split body must leave `lav` partitioning
        # the child circles. Before, only the B newborn took a fresh id —
        # circle mates kept the parent's, so ids did not partition the pool
        # and a cross-circle pair scanned as valid (measured sw00 body 3:
        # stale pair (4,0) across the {0,10,8}/{1..7} seam tied the true
        # (4,7) at bit-equal s_c and the a-credit tie-break welded the
        # circles -> stall, code 7). Every accepted split now gives BOTH
        # child circles fresh ids (A: lc+n_acc+iA, B: lc+iB — unique across
        # bodies because lc advances by 2*n_acc) and lavring walks them onto
        # the full membership; _sp_scan gates pairs on lav_a==lav_r==lav_b,
        # mirroring the oracle's per-LAV edge scan.
        front_walked = skel_relabel(
            front_rebuilt=front_rebuilt, is_ba=is_ba, is_b=is_B, lav_b=lav_B,
            cross_merge=cross_merge, lc=lc, n_acc=n_acc, ia=iA, pool_n=pool_n,
        )
        # D1-sweep gate counters (gd1=base_ok, gd2=pre_core, gd3=accept_pre,
        # gd4=accept_fin sums) — overwritten every iteration, read at exit
        # by skel_report's `_d_*` sample-index block, which composes them
        # into the six State gate vectors ga..gf -> gn_gate_a..f. (The
        # underscore spelling there means "consumed once below", NOT dead;
        # naming collides with the singular `gd` GATE-D attribute class.)
        # Phase-2d: Debug=False zeroes every counter by construction; flip
        # Debug=True LIVE to recover live diagnostics with no rebuild.
        # skel_clock consumes front_gd15 only as the POINT SET for the
        # constant-attribute code-3 statistic — never its gd values.
        front_gd1 = store_named_attribute(
            geometry=front_walked, name="gd1",
            value=switch(switch=debug, false=0.0, true=dbg_b,
                         input_type="FLOAT"),
            data_type="FLOAT", domain="POINT",
        )
        front_gd2 = store_named_attribute(
            geometry=front_gd1, name="gd2",
            value=switch(switch=debug, false=0.0, true=dbg_c,
                         input_type="FLOAT"),
            data_type="FLOAT", domain="POINT",
        )
        front_gd3 = store_named_attribute(
            geometry=front_gd2, name="gd3",
            value=switch(switch=debug, false=0.0, true=n_acc_pre,
                         input_type="FLOAT"),
            data_type="FLOAT", domain="POINT",
        )
        front_gd4 = store_named_attribute(
            geometry=front_gd3, name="gd4",
            value=switch(switch=debug, false=0.0, true=n_acc,
                         input_type="FLOAT"),
            data_type="FLOAT", domain="POINT",
        )
        front_gd5 = store_named_attribute(
            geometry=front_gd4, name="gd5",
            value=switch(
                switch=debug, false=0.0,
                true=math(value=win_x_s, value_001=site_x_s,
                          operation="SUBTRACT"),
                input_type="FLOAT",
            ),
            data_type="FLOAT", domain="POINT",
        )
        front_gd6 = store_named_attribute(
            geometry=front_gd5, name="gd6",
            value=switch(
                switch=debug, false=0.0,
                true=math(value=win_y_s, value_001=site_y_s,
                          operation="SUBTRACT"),
                input_type="FLOAT",
            ),
            data_type="FLOAT", domain="POINT",
        )
        front_gd7 = store_named_attribute(
            geometry=front_gd6, name="gd7",
            value=switch(
                switch=debug, false=0.0,
                true=math(value=win_a_s, value_001=site_a_s,
                          operation="SUBTRACT"),
                input_type="FLOAT",
            ),
            data_type="FLOAT", domain="POINT",
        )
        front_gd8 = store_named_attribute(
            geometry=front_gd7, name="gd8",
            value=switch(switch=debug, false=0.0, true=site_a_s,
                         input_type="FLOAT"),
            data_type="FLOAT", domain="POINT",
        )
        front_gd9 = store_named_attribute(
            geometry=front_gd8, name="gd9",
            value=switch(switch=debug, false=0.0, true=n_acc_dbg,
                         input_type="FLOAT"),
            data_type="FLOAT", domain="POINT",
        )
        front_gd10 = store_named_attribute(
            geometry=front_gd9, name="gd10",
            value=switch(switch=debug, false=0.0, true=site_x_s,
                         input_type="FLOAT"),
            data_type="FLOAT", domain="POINT",
        )
        front_gd11 = store_named_attribute(
            geometry=front_gd10, name="gd11",
            value=switch(switch=debug, false=0.0, true=site_y_s,
                         input_type="FLOAT"),
            data_type="FLOAT", domain="POINT",
        )
        front_gd12 = store_named_attribute(
            geometry=front_gd11, name="gd12",
            value=switch(switch=debug, false=0.0, true=win_x_s,
                         input_type="FLOAT"),
            data_type="FLOAT", domain="POINT",
        )
        front_gd13 = store_named_attribute(
            geometry=front_gd12, name="gd13",
            value=switch(switch=debug, false=0.0, true=win_y_s,
                         input_type="FLOAT"),
            data_type="FLOAT", domain="POINT",
        )
        front_gd14 = store_named_attribute(
            geometry=front_gd13, name="gd14",
            value=switch(switch=debug, false=0.0, true=cloud_n_s,
                         input_type="FLOAT"),
            data_type="FLOAT", domain="POINT",
        )
        front_gd15 = store_named_attribute(
            geometry=front_gd14, name="gd15",
            value=switch(switch=debug, false=0.0, true=cloud_x_s,
                         input_type="FLOAT"),
            data_type="FLOAT", domain="POINT",
        )

        # --- clock + zone tail via skel_clock ------------------------------
        tnow_out, it_out, done_out, ec_out, bc_out, lc_out = skel_clock(
            done=done, not_done=not_done, t_min=t_min, tnow=tnow, it=it,
            total_col=total_col, any_site=any_site, no_event=no_event,
            ring2_b=ring2_b, alive=alive, front=front, maxiter=max_events,
            z_it=index, cap_ok=cap_ok, n_acc_pre=n_acc_pre, s_st=s_st,
            pre_core=pre_core, det_bad=det_bad, det_ok=det_ok, xlav_b=xlav_b,
            amb5_s_row=amb5_s_row, amb5_e=amb5_e, ec=ec, bc=bc, lc=lc,
            n_acc=n_acc, front_gd15=front_gd15,
        )
        # --- lane A done-gate (2026-08-27): skip the whole heavy body on
        # post-termination iterations ---------------------------------------
        # The zone has no break, so after `done` latches the body keeps
        # grinding full-size clouds for the remaining budget (~75% of a
        # default-64 solve: every current fixture converges <= 15). A native
        # Switch keyed on the zone-input `done` passes every state through
        # unchanged instead: geometry is not a field type, so the engine
        # takes LazyFunctionForSwitchNode::execute_single and marks the
        # unselected input UNUSED (blender 5.2 node_geo_switch.cc:187
        # set_input_unused) — the heavy chain's ONLY consumers become the
        # gates' false-inputs, so the lazy evaluator skips it whole.
        # Grove's switch() wrapper is annotated -> Float, but the socket
        # type follows the input_type prop (probe probe.switchgeo.v1,
        # 2026-08-27: input_type="GEOMETRY" into a Geometry zone state
        # compiles and passes the strict zone-state check) — the fold's old
        # [zone-state-mismatch] note measured the annotation, not the emit.
        # Bit-inertness on done iterations: tnow/it/bc/lc already latch
        # (skel_clock switch-on-done); done OR done_raw is True when done;
        # arcs join contributes only empty sets (hold drops every event
        # record; caps/ridge latch with td; no sites -> no uarc/warc); the
        # gd stores write the same constants over frozen columns; ec passes
        # through with the latched value (first-error-sticks). The
        # 43-fixture ARC-HASH battery + state surface are the proof — a
        # hash change here is a defect, not a tuning knob.
        has_event = boolean_math(boolean=no_event, operation="NOT")
        cap_after_front = compare(a=t_min, b=t_cap, operation="GREATER_THAN")
        cap_enabled = boolean_math(
            boolean=cap_on,
            boolean_001=boolean_math(boolean=cap_input_bad, operation="NOT"),
            operation="AND",
        )
        cap_now = boolean_math(
            boolean=boolean_math(
                boolean=cap_enabled, boolean_001=has_event, operation="AND"
            ),
            boolean_001=cap_after_front,
            operation="AND",
        )
        cap_terminal_arcs = join_geometry([arcs, caps, ridge])
        next_front = switch(
            switch=cap_now, false=front_gd15, true=front,
            input_type="GEOMETRY",
        )
        next_arcs = switch(
            switch=cap_now, false=arcs_out, true=cap_terminal_arcs,
            input_type="GEOMETRY",
        )
        next_tnow = switch(
            switch=cap_now, false=tnow_out, true=t_cap, input_type="FLOAT"
        )
        next_done = switch(
            switch=cap_now, false=done_out, true=True, input_type="BOOLEAN"
        )
        next_ec = switch(switch=cap_now, false=ec_out, true=ec, input_type="FLOAT")
        next_it = switch(switch=cap_now, false=it_out, true=it, input_type="FLOAT")
        next_bc = switch(switch=cap_now, false=bc_out, true=bc, input_type="FLOAT")
        next_lc = switch(switch=cap_now, false=lc_out, true=lc, input_type="FLOAT")
        next_capped = boolean_math(boolean=capped, boolean_001=cap_now, operation="OR")

        gate_front = switch(
            switch=done, false=next_front, true=front, input_type="GEOMETRY"
        )
        gate_arcs = switch(
            switch=done, false=next_arcs, true=arcs, input_type="GEOMETRY"
        )
        gate_tnow = switch(switch=done, false=next_tnow, true=tnow, input_type="FLOAT")
        gate_done = switch(switch=done, false=next_done, true=done, input_type="BOOLEAN")
        gate_ec = switch(switch=done, false=next_ec, true=ec, input_type="FLOAT")
        gate_it = switch(switch=done, false=next_it, true=it, input_type="FLOAT")
        gate_bc = switch(switch=done, false=next_bc, true=bc, input_type="FLOAT")
        gate_lc = switch(switch=done, false=next_lc, true=lc, input_type="FLOAT")
        gate_capped = switch(
            switch=done, false=next_capped, true=capped, input_type="BOOLEAN"
        )
        return (
            gate_front, gate_arcs, gate_tnow, gate_done,
            gate_ec, gate_it, gate_bc, gate_lc, gate_capped,
        )

    pre_solve_bad = boolean_math(
        boolean=c9_bad, boolean_001=c1_bad, operation="OR"
    )
    pre_solve_bad_all = boolean_math(
        boolean=pre_solve_bad, boolean_001=cap_input_bad, operation="OR"
    )
    (
        _front_end, arcs_end, _t_end, _done_end, ec_end, it_end,
        _bc_end, _lc_end, capped_end,
    ) = solve(front0, arcs0, 0.0, pre_solve_bad_all, 0.0, 0.0, 0.0, 1.0, False)

    # ---------- S8+S8b: roof faces (extracted step 18) ----------------------
    aa_f = input_named_attribute(name="aa", data_type="FLOAT_VECTOR")
    bb_f = input_named_attribute(name="bb", data_type="FLOAT_VECTOR")
    al_f = input_named_attribute(name="al", data_type="FLOAT")
    ar_f = input_named_attribute(name="ar", data_type="FLOAT")
    cp_f = input_named_attribute(name="cp", data_type="FLOAT")
    cap_arcs, plateau_mesh, cap_bad = skel_cap_emit(
        front=_front_end, arcs=arcs_end, t_cap=t_cap,
        active=capped_end, weld_distance=weld_distance,
    )
    styled_arcs = skel_style_arcs(arcs=cap_arcs)
    emitted_roof_mesh = skel_faces(
        ring=solver_ring, arcs_end=styled_arcs, nf=terminal_nf,
        aa_f=aa_f, bb_f=bb_f, al_f=al_f, ar_f=ar_f, cp_f=cp_f,
        identity_stable=canonical,
        weld_distance=weld_distance,
    )
    cap_face_id = float_to_int(float=terminal_nf, rounding_mode="ROUND")
    plateau_component = store_named_attribute(
        geometry=plateau_mesh,
        name="gn_component_id", value=0,
        data_type="INT", domain="FACE",
    )
    plateau_contour = store_named_attribute(
        geometry=plateau_component,
        name="gn_contour_id", value=-1,
        data_type="INT", domain="FACE",
    )
    plateau_source = store_named_attribute(
        geometry=plateau_contour,
        name="gn_source_boundary_id", value=-1,
        data_type="INT", domain="FACE",
    )
    plateau_face = store_named_attribute(
        geometry=plateau_source,
        name="gn_roof_face_id", value=cap_face_id,
        data_type="INT", domain="FACE",
    )
    plateau_class = store_named_attribute(
        geometry=plateau_face,
        name="gn_roof_face_class", value=2,
        data_type="INT", domain="FACE",
    )
    plateau_identity = store_named_attribute(
        geometry=plateau_class,
        name="gn_identity_stable", value=canonical,
        data_type="BOOLEAN", domain="FACE",
    )
    roof_with_plateau = join_geometry([emitted_roof_mesh, plateau_identity])
    roof_semantic = skel_roof_semantics(
        roof_mesh=roof_with_plateau,
        weld_distance=weld_distance,
    )
    local_roof_mesh = skel_height(
        roof_mesh=roof_semantic,
        pitch_deg=PitchDeg,
        eave_z=EaveZ,
    )
    roof_mesh = set_position(
        geometry=local_roof_mesh,
        position=vector_math(
            vector=input_position(), vector_001=solve_origin, operation="ADD"
        ),
    )
    world_aa = vector_math(vector=aa_f, vector_001=solve_origin, operation="ADD")
    world_bb = vector_math(vector=bb_f, vector_001=solve_origin, operation="ADD")
    solve_origin_z = separate_xyz(vector=solve_origin).z
    arcs_world_aa = store_named_attribute(
        geometry=styled_arcs, name="aa", value=world_aa,
        data_type="FLOAT_VECTOR", domain="POINT",
    )
    arcs_world = store_named_attribute(
        geometry=arcs_world_aa, name="bb", value=world_bb,
        data_type="FLOAT_VECTOR", domain="POINT",
    )

    # ---------- report: evidence geometry + State carriers (extracted step 19)
    return skel_report(
        front_end=_front_end,
        arcs_end=arcs_world,
        roof_mesh=roof_mesh,
        solve_origin_z=solve_origin_z,
        cp_f=cp_f,
        it_end=it_end,
        t_end=_t_end,
        bc_end=_bc_end,
        ec_end=ec_end,
        w8_bad=boolean_math(boolean=w8_all, boolean_001=cap_bad, operation="OR"),
        c9_bad=c9_bad,
        c1_bad=c1_bad,
        emit_skeleton=emit_skeleton,
    )
