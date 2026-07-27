import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';

const STATUSES = ['PENDING', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'APPROVED', 'DONE'];

export default function Tasks() {
  const { activeOrg, user } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newTitle, setNewTitle] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(false);

  const load = useCallback(async () => {
    if (!activeOrg) return;
    setLoading(true);
    try {
      const data = await api.listTasks(activeOrg.id);
      setTasks(data.tasks || data);
    } catch (err) {
      setError(err.body?.error || 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [activeOrg]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    try {
      await api.createTask(activeOrg.id, { title: newTitle, requiresApproval });
      setNewTitle('');
      setRequiresApproval(false);
      load();
    } catch (err) {
      setError(err.body?.error || 'Failed to create task');
    }
  }

  async function handleStatusChange(task, status) {
    try {
      await api.updateTask(activeOrg.id, task.id, { status });
      load();
    } catch (err) {
      // e.g. INC-013: can't jump to DONE without approval first
      setError(err.body?.error || 'Failed to update task');
    }
  }

  async function handleApprove(task) {
    try {
      await api.approveTask(activeOrg.id, task.id);
      load();
    } catch (err) {
      setError(err.body?.error || 'Failed to approve task');
    }
  }

  async function handleReject(task) {
    try {
      await api.rejectTask(activeOrg.id, task.id);
      load();
    } catch (err) {
      setError(err.body?.error || 'Failed to reject task');
    }
  }

  if (!activeOrg) return <div className="page">Select an organisation first.</div>;

  return (
    <div className="page">
      <h1>Tasks</h1>
      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}

      <form className="inline-form" onSubmit={handleCreate}>
        <input
          placeholder="New task title"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <label className="checkbox-label">
          <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} />
          Requires approval
        </label>
        <button type="submit">Add task</button>
      </form>

      {loading ? (
        <p>Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="muted">No tasks yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Approval</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>{task.title}</td>
                <td>
                  <select value={task.status} onChange={(e) => handleStatusChange(task, e.target.value)}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
                <td>{task.requiresApproval ? 'Required' : '—'}</td>
                <td>
                  {task.status === 'AWAITING_APPROVAL' && task.createdById !== user.id && (
                    <>
                      <button onClick={() => handleApprove(task)}>Approve</button>
                      <button onClick={() => handleReject(task)}>Reject</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
