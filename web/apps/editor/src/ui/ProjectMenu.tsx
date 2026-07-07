// ProjectMenu — the toolbar project switcher: list / open / create / rename /
// delete. Opening a different project is a full reload (the app graph is a
// stateful singleton; see services/projects.ts).

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

export function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [name, setName] = useState(() => activeProject().name);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void listProjects().then(setProjects);
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const current = activeProject();

  const onNew = async () => {
    const projectName = window.prompt('New project name:', 'Untitled');
    if (projectName == null) return;
    const p = await createProject(projectName);
    openProject(p.id); // reload into the new (blank) project
  };

  const onRename = async () => {
    const next = window.prompt('Rename project:', current.name);
    if (next == null || !next.trim()) return;
    await renameProject(current.id, next);
    setName(next.trim());
    setProjects(await listProjects());
  };

  const onDelete = async (p: ProjectMeta) => {
    const ok = window.confirm(
      `Delete project "${p.name}" and all of its media, history and document? This cannot be undone.`,
    );
    if (!ok) return;
    await deleteProject(p.id);
    if (p.id === current.id) {
      location.reload(); // active pointer already re-targeted by deleteProject
    } else {
      setProjects(await listProjects());
    }
  };

  return (
    <div className="project-menu" ref={rootRef}>
      <button className="project-current" title="Projects" onClick={() => setOpen((v) => !v)}>
        {name} ▾
      </button>
      {open && (
        <div className="ctx-menu project-dropdown">
          {projects.map((p) => (
            <div className="project-row" key={p.id}>
              <button
                className={p.id === current.id ? 'project-active' : undefined}
                onClick={() => {
                  if (p.id !== current.id) openProject(p.id);
                  else setOpen(false);
                }}
              >
                {p.id === current.id ? '● ' : ''}
                {p.name}
              </button>
              <button
                className="ctx-danger project-delete"
                title={`Delete "${p.name}"`}
                onClick={() => void onDelete(p)}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="project-sep" />
          <button onClick={() => void onNew()}>+ New Project</button>
          <button onClick={() => void onRename()}>Rename Current…</button>
        </div>
      )}
    </div>
  );
}
