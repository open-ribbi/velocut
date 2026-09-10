import { useEffect, useRef, useState } from 'react';
import {
  activeProject,
  listProjects,
  createProject,
  renameProject,
  deleteProject,
  openProject,
  type ProjectMeta,
} from '../services/projects';
import { Dialog } from './primitives/Dialog';
import { Icon } from './primitives/Icon';

type Action = { kind: 'new' } | { kind: 'rename' } | { kind: 'delete'; project: ProjectMeta };
export function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [name, setName] = useState(() => activeProject().name);
  const [action, setAction] = useState<Action | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = activeProject();
  useEffect(() => {
    if (!open) return;
    void listProjects().then(setProjects);
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const begin = (next: Action) => {
    setDraft(next.kind === 'rename' ? name : 'Untitled');
    setError('');
    setOpen(false);
    setAction(next);
  };
  const submit = async () => {
    if (!action || busy) return;
    setBusy(true);
    setError('');
    try {
      if (action.kind === 'new') {
        const p = await createProject(draft.trim());
        openProject(p.id);
      } else if (action.kind === 'rename') {
        await renameProject(current.id, draft.trim());
        setName(draft.trim());
        setAction(null);
      } else {
        await deleteProject(action.project.id);
        if (action.project.id === current.id) location.reload();
        else {
          setProjects(await listProjects());
          setAction(null);
          setOpen(true);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const title =
    action?.kind === 'delete'
      ? 'Delete project'
      : action?.kind === 'rename'
        ? 'Rename project'
        : 'New project';
  return (
    <div className="project-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        className="project-current"
        title="Projects"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{name}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <div className="ctx-menu project-dropdown" aria-label="Projects">
          <span className="menu-caption">YOUR PROJECTS</span>
          <div className="project-list">
            {projects.map((p) => (
              <div className="project-row" key={p.id}>
                <button
                  className={p.id === current.id ? 'project-active' : undefined}
                  onClick={() => {
                    if (p.id !== current.id) openProject(p.id);
                    else setOpen(false);
                  }}
                >
                  <Icon name={p.id === current.id ? 'check' : 'folder'} size={15} />
                  <span>{p.name}</span>
                </button>
                <button
                  className="ctx-danger project-delete"
                  aria-label={`Delete "${p.name}"`}
                  title={`Delete "${p.name}"`}
                  onClick={() => begin({ kind: 'delete', project: p })}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
          <div className="project-sep" />
          <button onClick={() => begin({ kind: 'new' })}>
            <Icon name="plus" size={15} />
            New Project
          </button>
          <button onClick={() => begin({ kind: 'rename' })}>
            <Icon name="text" size={15} />
            Rename Current…
          </button>
        </div>
      )}
      <Dialog
        open={!!action}
        title={title}
        onClose={() => {
          if (!busy) setAction(null);
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {action?.kind === 'delete' ? (
            <p>
              Delete <strong>{action.project.name}</strong> and its media, history and document?
              This cannot be undone.
            </p>
          ) : (
            <label className="dialog-field">
              Project name
              <input
                aria-label="Project name"
                value={draft}
                maxLength={120}
                onChange={(e) => setDraft(e.target.value)}
                autoFocus
                required
              />
            </label>
          )}
          {error && (
            <p className="export-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" disabled={busy} onClick={() => setAction(null)}>
              Cancel
            </button>
            <button
              className={action?.kind === 'delete' ? 'danger-button' : 'primary'}
              disabled={busy || (action?.kind !== 'delete' && !draft.trim())}
            >
              {busy
                ? 'Saving…'
                : action?.kind === 'delete'
                  ? 'Delete project'
                  : action?.kind === 'new'
                    ? 'Create project'
                    : 'Save name'}
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
