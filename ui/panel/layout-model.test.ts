// panel-layout-tree (PL1.2, PL-D9): bun tests for the pure layout-tree model.
// Run (part of the verify procedure, see AGENTS.md):
//   cd HostKitCore && bun test ui/panel/layout-model.test.ts
import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_CELL_SIZE_PX,
  MIN_CELL_SIZE_PX,
  TRACKS_PANEL_ID,
  containsPanel,
  defaultLayout,
  deserializeLayout,
  dockAxisOf,
  dockToCell,
  dockToEdge,
  findPanelPath,
  flexChildIndex,
  isDockedInTree,
  listPanelIds,
  migrateLegacyPanelModes,
  nodeAtPath,
  normalize,
  removePanel,
  serializeLayout,
  setChildSizes,
  validateLayout,
  type LayoutNode,
  type LayoutSplitNode,
} from './layout-model'

const asSplit = (node: LayoutNode): LayoutSplitNode => {
  expect(node.kind).toBe('split')
  return node as LayoutSplitNode
}

describe('defaults and invariants', () => {
  test('default layout is a single flex tracks cell and validates', () => {
    const tree = defaultLayout()
    expect(tree).toEqual({ kind: 'cell', panelId: TRACKS_PANEL_ID, sizePx: null })
    expect(validateLayout(tree)).toBe(true)
  })

  test('tracks cell cannot be removed', () => {
    const tree = dockToEdge(defaultLayout(), 'a', 'left', 300)
    expect(removePanel(tree, TRACKS_PANEL_ID)).toBe(tree)
  })

  test('tracks cell can be MOVED (PL-D10): to an edge and under another cell, staying flex', () => {
    const base = dockToEdge(defaultLayout(), 'a', 'left', 300) // row [a, tracks]

    const movedLeft = asSplit(dockToEdge(base, TRACKS_PANEL_ID, 'left'))
    expect(listPanelIds(movedLeft)).toEqual([TRACKS_PANEL_ID, 'a'])
    expect(movedLeft.children[0]?.sizePx).toBeNull() // tracks остаётся flex-ветвью
    expect(movedLeft.children[1]?.sizePx).not.toBeNull()
    expect(validateLayout(movedLeft)).toBe(true)

    const movedUnder = asSplit(dockToCell(base, TRACKS_PANEL_ID, 'a', 'bottom'))
    expect(movedUnder.axis).toBe('column')
    expect(listPanelIds(movedUnder)).toEqual(['a', TRACKS_PANEL_ID])
    expect(movedUnder.children[1]?.sizePx).toBeNull()
    expect(validateLayout(movedUnder)).toBe(true)

    // Единственная ячейка дерева — двигать не к чему, no-op.
    expect(dockToEdge(defaultLayout(), TRACKS_PANEL_ID, 'left')).toEqual(defaultLayout())
    // Исчезнувшая цель для tracks НЕ деградирует в краевой док — просто no-op.
    expect(dockToCell(base, TRACKS_PANEL_ID, 'ghost', 'bottom')).toEqual(base)
  })
})

describe('dockToEdge (req. 2: window sides span the full dimension)', () => {
  test('left edge wraps the root into a row with the panel first', () => {
    const tree = asSplit(dockToEdge(defaultLayout(), 'a', 'left', 300))
    expect(tree.axis).toBe('row')
    expect(listPanelIds(tree)).toEqual(['a', TRACKS_PANEL_ID])
    expect(tree.children[0]).toEqual({ kind: 'cell', panelId: 'a', sizePx: 300 })
    expect(tree.children[1]?.sizePx).toBeNull()
  })

  test('right edge appends after existing content', () => {
    const tree = asSplit(dockToEdge(dockToEdge(defaultLayout(), 'a', 'left', 300), 'b', 'right', 200))
    expect(tree.axis).toBe('row')
    expect(listPanelIds(tree)).toEqual(['a', TRACKS_PANEL_ID, 'b'])
  })

  test('top edge over a row wraps into a column — the panel spans the full width', () => {
    const row = dockToEdge(defaultLayout(), 'a', 'left', 300)
    const tree = asSplit(dockToEdge(row, 'b', 'top', 180))
    expect(tree.axis).toBe('column')
    expect(tree.children[0]).toEqual({ kind: 'cell', panelId: 'b', sizePx: 180 })
    const inner = asSplit(tree.children[1] as LayoutNode)
    expect(inner.axis).toBe('row')
    expect(inner.sizePx).toBeNull()
    expect(listPanelIds(inner)).toEqual(['a', TRACKS_PANEL_ID])
  })

  test('re-docking an already docked panel moves it (no duplicates)', () => {
    const tree = dockToEdge(dockToEdge(defaultLayout(), 'a', 'left', 300), 'a', 'bottom', 220)
    expect(listPanelIds(tree)).toEqual([TRACKS_PANEL_ID, 'a'])
    expect(asSplit(tree).axis).toBe('column')
    expect(validateLayout(tree)).toBe(true)
  })

  test('size is clamped to the hard floor', () => {
    const tree = asSplit(dockToEdge(defaultLayout(), 'a', 'left', 1))
    expect(tree.children[0]?.sizePx).toBe(MIN_CELL_SIZE_PX)
  })
})

describe('dockToCell (req. 3: shared dimension via structure)', () => {
  test("owner's scenario: a panel docked under the tracks cell shares its width", () => {
    // right-docked editor + points panel under tracks: the points cell lives in a column with
    // the tracks cell only, so it cannot span under the right panel — widths match structurally.
    const base = dockToEdge(defaultLayout(), 'track-editor', 'right', 460)
    const tree = asSplit(dockToCell(base, 'point-inspector', TRACKS_PANEL_ID, 'bottom', 260))
    expect(tree.axis).toBe('row')
    const column = asSplit(tree.children[0] as LayoutNode)
    expect(column.axis).toBe('column')
    expect(listPanelIds(column)).toEqual([TRACKS_PANEL_ID, 'point-inspector'])
    expect(column.children[0]?.sizePx).toBeNull()
    expect(column.children[1]?.sizePx).toBe(260)
    expect(validateLayout(tree)).toBe(true)
  })

  test('docking to a plain panel cell splits that cell and keeps its slot size', () => {
    const base = dockToEdge(defaultLayout(), 'a', 'left', 300)
    const tree = asSplit(dockToCell(base, 'b', 'a', 'bottom', 150))
    const leftBranch = asSplit(tree.children[0] as LayoutNode)
    expect(leftBranch.axis).toBe('column')
    expect(leftBranch.sizePx).toBe(300)
    expect(listPanelIds(leftBranch)).toEqual(['a', 'b'])
    // Inside a tracks-free split the LAST child flexes; 'b' (trailing) flexes, 'a' holds px.
    expect(flexChildIndex(leftBranch)).toBe(1)
    expect(leftBranch.children[1]?.sizePx).toBeNull()
    expect(leftBranch.children[0]?.sizePx).not.toBeNull()
  })

  test('same-axis cell split becomes a sibling insertion after normalize', () => {
    const base = dockToEdge(defaultLayout(), 'a', 'left', 300)
    const tree = asSplit(dockToCell(base, 'b', 'a', 'left', 120))
    // b | a | tracks — one flat row, not a nested row-in-row.
    expect(tree.axis).toBe('row')
    expect(tree.children).toHaveLength(3)
    expect(listPanelIds(tree)).toEqual(['b', 'a', TRACKS_PANEL_ID])
    expect(validateLayout(tree)).toBe(true)
  })

  test('docking onto itself is a no-op', () => {
    const base = dockToEdge(defaultLayout(), 'a', 'left', 300)
    expect(dockToCell(base, 'a', 'a', 'bottom')).toBe(base)
  })

  test('vanished target degrades to the corresponding window edge', () => {
    const tree = asSplit(dockToCell(defaultLayout(), 'a', 'ghost', 'bottom', 200))
    expect(tree.axis).toBe('column')
    expect(listPanelIds(tree)).toEqual([TRACKS_PANEL_ID, 'a'])
  })
})

describe('removePanel and normalize', () => {
  test('removing the last sibling collapses the degenerate split', () => {
    const tree = removePanel(dockToEdge(defaultLayout(), 'a', 'left', 300), 'a')
    expect(tree).toEqual(defaultLayout())
  })

  test('removing a mid-tree panel keeps the rest intact and valid', () => {
    let tree = dockToEdge(defaultLayout(), 'a', 'left', 300)
    tree = dockToCell(tree, 'b', 'a', 'bottom', 150)
    tree = dockToEdge(tree, 'c', 'bottom', 200)
    const after = removePanel(tree, 'a')
    expect(listPanelIds(after)).toEqual(['b', TRACKS_PANEL_ID, 'c'])
    expect(validateLayout(after)).toBe(true)
    // 'b' was the flex child of the a/b column; alone it inherits the column's slot px.
    const row = asSplit(asSplit(after).children[0] as LayoutNode)
    expect(row.children[0]).toEqual({ kind: 'cell', panelId: 'b', sizePx: 300 })
  })

  test('removing an absent panel returns an equal tree', () => {
    const tree = dockToEdge(defaultLayout(), 'a', 'left', 300)
    expect(removePanel(tree, 'ghost')).toEqual(tree)
  })

  test('normalize enforces exactly one flex child per split', () => {
    const broken: LayoutNode = {
      kind: 'split',
      axis: 'row',
      sizePx: null,
      children: [
        { kind: 'cell', panelId: 'a', sizePx: null },
        { kind: 'cell', panelId: TRACKS_PANEL_ID, sizePx: 500 },
        { kind: 'cell', panelId: 'b', sizePx: null },
      ],
    }
    const fixed = asSplit(normalize(broken))
    expect(fixed.children.map((c) => c.sizePx)).toEqual([DEFAULT_CELL_SIZE_PX, null, DEFAULT_CELL_SIZE_PX])
  })
})

describe('paths and sizes', () => {
  test('findPanelPath / nodeAtPath round-trip', () => {
    let tree = dockToEdge(defaultLayout(), 'a', 'left', 300)
    tree = dockToCell(tree, 'b', 'a', 'bottom', 150)
    const path = findPanelPath(tree, 'a')
    expect(path).toEqual([0, 0])
    const node = nodeAtPath(tree, path ?? [])
    expect(node).toEqual({ kind: 'cell', panelId: 'a', sizePx: expect.any(Number) })
    expect(findPanelPath(tree, TRACKS_PANEL_ID)).toEqual([1])
    expect(findPanelPath(tree, 'ghost')).toBeNull()
  })

  test('dockAxisOf reports the hosting split axis (dock orientation)', () => {
    let tree = dockToEdge(defaultLayout(), 'a', 'left', 300)
    tree = dockToCell(tree, 'b', TRACKS_PANEL_ID, 'bottom', 200)
    expect(dockAxisOf(tree, 'a')).toBe('row')
    expect(dockAxisOf(tree, 'b')).toBe('column')
    expect(dockAxisOf(tree, 'ghost')).toBeNull()
    expect(dockAxisOf(defaultLayout(), TRACKS_PANEL_ID)).toBeNull()
  })

  test('setChildSizes updates several children of one split atomically, immutably and clamped', () => {
    // row [a 300, tracks flex, b 200] — тот случай, где сплиттер стоит между двумя px-детьми.
    const tree = dockToEdge(dockToEdge(defaultLayout(), 'a', 'left', 300), 'b', 'right', 200)
    const resized = asSplit(
      setChildSizes(tree, [], [
        { index: 0, sizePx: 360 },
        { index: 2, sizePx: 5 },
      ]),
    )
    expect(resized.children[0]?.sizePx).toBe(360)
    expect(resized.children[1]?.sizePx).toBeNull() // flex-ветка не тронута, дерево не нормализовано
    expect(resized.children[2]?.sizePx).toBe(MIN_CELL_SIZE_PX)
    expect(asSplit(tree).children[0]?.sizePx).toBe(300)
    expect(asSplit(tree).children[2]?.sizePx).toBe(200)
  })

  test('setChildSizes ignores bad paths, out-of-range indices and empty updates', () => {
    const tree = dockToEdge(defaultLayout(), 'a', 'left', 300)
    expect(setChildSizes(tree, [], [])).toBe(tree)
    expect(setChildSizes(tree, [0], [{ index: 0, sizePx: 500 }])).toEqual(tree) // путь ведёт в ячейку
    expect(setChildSizes(tree, [9], [{ index: 0, sizePx: 500 }])).toEqual(tree)
    expect(setChildSizes(tree, [], [{ index: 9, sizePx: 500 }])).toEqual(tree)
  })
})

describe('serialization (PL-D4)', () => {
  test('serialize → deserialize round-trips a real tree', () => {
    let tree = dockToEdge(defaultLayout(), 'track-editor', 'right', 460)
    tree = dockToCell(tree, 'point-inspector', TRACKS_PANEL_ID, 'bottom', 260)
    tree = dockToEdge(tree, 'undo-journal', 'left', 320)
    expect(deserializeLayout(serializeLayout(tree))).toEqual(tree)
  })

  test.each([
    ['null/empty', ''],
    ['not json', '{oops'],
    ['wrong version', JSON.stringify({ v: 99, root: { kind: 'cell', panelId: TRACKS_PANEL_ID, sizePx: null } })],
    ['unknown kind', JSON.stringify({ v: 1, root: { kind: 'blob' } })],
    ['bad axis', JSON.stringify({ v: 1, root: { kind: 'split', axis: 'diag', sizePx: null, children: [] } })],
    ['tracks missing', JSON.stringify({ v: 1, root: { kind: 'cell', panelId: 'a', sizePx: null } })],
    [
      'duplicate panel ids',
      JSON.stringify({
        v: 1,
        root: {
          kind: 'split',
          axis: 'row',
          sizePx: null,
          children: [
            { kind: 'cell', panelId: 'a', sizePx: 100 },
            { kind: 'cell', panelId: 'a', sizePx: 100 },
            { kind: 'cell', panelId: TRACKS_PANEL_ID, sizePx: null },
          ],
        },
      }),
    ],
  ])('invalid payload (%s) yields null', (_label, raw) => {
    expect(deserializeLayout(raw)).toBeNull()
  })

  test('deserialization normalizes degenerate persisted shapes', () => {
    const raw = JSON.stringify({
      v: 1,
      root: {
        kind: 'split',
        axis: 'row',
        sizePx: null,
        children: [
          {
            kind: 'split',
            axis: 'row',
            sizePx: null,
            children: [
              { kind: 'cell', panelId: 'a', sizePx: 200 },
              { kind: 'cell', panelId: TRACKS_PANEL_ID, sizePx: null },
            ],
          },
        ],
      },
    })
    const tree = deserializeLayout(raw)
    expect(tree).not.toBeNull()
    expect(asSplit(tree as LayoutNode).children).toHaveLength(2)
    expect(validateLayout(tree as LayoutNode)).toBe(true)
  })
})

describe('legacy migration (PL-D4)', () => {
  test('edge modes become root-level docks in entry order, others are skipped', () => {
    const tree = migrateLegacyPanelModes([
      { panelId: 'track-editor', mode: 'right', dockSize: 460 },
      { panelId: 'track-history', mode: 'right', dockSize: 360 },
      { panelId: 'file-open', mode: 'floating', dockSize: 380 },
      { panelId: 'undo-journal', mode: 'bottom', dockSize: 240 },
      { panelId: 'track-list', mode: 'detached', dockSize: 300 },
    ])
    expect(isDockedInTree(tree, 'file-open')).toBe(false)
    expect(isDockedInTree(tree, 'track-list')).toBe(false)
    expect(listPanelIds(tree)).toContain('track-editor')
    expect(listPanelIds(tree)).toContain('track-history')
    expect(listPanelIds(tree)).toContain('undo-journal')
    expect(validateLayout(tree)).toBe(true)
    // The bottom panel wraps the row — it spans the full width, as the legacy column mode did.
    expect(asSplit(tree).axis).toBe('column')
  })

  test('garbage dock sizes fall back to the default', () => {
    const tree = asSplit(migrateLegacyPanelModes([{ panelId: 'a', mode: 'left', dockSize: Number.NaN }]))
    expect(tree.children[0]?.sizePx).toBe(DEFAULT_CELL_SIZE_PX)
  })

  test('empty legacy state yields the default layout', () => {
    expect(migrateLegacyPanelModes([])).toEqual(defaultLayout())
    expect(containsPanel(migrateLegacyPanelModes([]), TRACKS_PANEL_ID)).toBe(true)
  })
})
