// The editor's document state: the project, undo history and selection. No DOM, so it's unit-testable.

import type { OutputSettings, Project, ZoomSegment } from '../../shared/project'

const HISTORY_LIMIT = 100

export interface EditorState {
  project: Project
  past: Project[]
  future: Project[]
  // The project as it was when a drag began. The whole drag is one undo step
  gestureBase: Project | null
  selectedId: string | null
}

export type EditorAction =
  | { type: 'edit'; change: (project: Project) => Project }
  | { type: 'output'; change: (output: OutputSettings) => OutputSettings }
  | { type: 'gesture-start' }
  | { type: 'gesture-end' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; id: string | null }

export function initialState(project: Project): EditorState {
  return { project, past: [], future: [], gestureBase: null, selectedId: null }
}

// Keeps the project's identity when the zooms didn't change, so no-ops cost no undo step
export function withZooms(project: Project, zooms: ZoomSegment[]): Project {
  return zooms === project.zooms ? project : { ...project, zooms }
}

function sameDoc(a: Project, b: Project): boolean {
  return (Object.keys(a) as (keyof Project)[]).every((k) => Object.is(a[k], b[k]))
}

function push(past: Project[], project: Project): Project[] {
  return [...past, project].slice(-HISTORY_LIMIT)
}

// Output settings are preferences, not edits, so undo leaves them alone
function restore(snapshot: Project, current: Project): Project {
  return { ...snapshot, output: current.output }
}

function keepSelection(state: EditorState): EditorState {
  const { selectedId, project } = state
  if (selectedId && !project.zooms.some((z) => z.id === selectedId)) return { ...state, selectedId: null }
  return state
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'edit': {
      const project = action.change(state.project)
      if (project === state.project) return state
      if (state.gestureBase) return keepSelection({ ...state, project })
      return keepSelection({ ...state, project, past: push(state.past, state.project), future: [] })
    }
    case 'output':
      return { ...state, project: { ...state.project, output: action.change(state.project.output) } }
    case 'gesture-start':
      return state.gestureBase ? state : { ...state, gestureBase: state.project }
    case 'gesture-end': {
      const base = state.gestureBase
      if (!base) return state
      if (sameDoc(base, state.project)) return { ...state, project: base, gestureBase: null }
      return { ...state, gestureBase: null, past: push(state.past, base), future: [] }
    }
    case 'undo': {
      const snapshot = state.past[state.past.length - 1]
      if (!snapshot || state.gestureBase) return state
      return keepSelection({
        ...state,
        project: restore(snapshot, state.project),
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future]
      })
    }
    case 'redo': {
      const snapshot = state.future[0]
      if (!snapshot || state.gestureBase) return state
      return keepSelection({
        ...state,
        project: restore(snapshot, state.project),
        past: push(state.past, state.project),
        future: state.future.slice(1)
      })
    }
    case 'select':
      return state.selectedId === action.id ? state : { ...state, selectedId: action.id }
  }
}
