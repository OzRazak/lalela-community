import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { getPrompts, savePrompts, DEFAULT_PROMPTS, type Prompt } from "@/lib/settings";
import { Plus, Trash2 } from "lucide-react";

/** Editable prompt library (shared by Settings and the Library view).
 * Edits persist to localStorage as you type. */
export function PromptLibrary() {
  const [prompts, setPrompts] = useState<Prompt[]>(getPrompts());

  const persist = (next: Prompt[]) => {
    setPrompts(next);
    savePrompts(next);
  };

  const updatePrompt = (id: string, patch: Partial<Prompt>) =>
    persist(prompts.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const addPrompt = () =>
    persist([...prompts, { id: `custom-${Date.now()}`, name: "New prompt", text: "" }]);

  const deletePrompt = (id: string) => persist(prompts.filter((p) => p.id !== id));

  return (
    <div>
      <div className="space-y-3">
        {prompts.map((p) => (
          <div key={p.id} className="rounded-[var(--radius)] border border-border p-3">
            <div className="flex items-center gap-2">
              <input
                value={p.name}
                onChange={(e) => updatePrompt(p.id, { name: e.target.value })}
                className="flex-1 bg-transparent text-sm font-semibold outline-none"
              />
              <button
                onClick={() => deletePrompt(p.id)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-danger"
                title="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <textarea
              value={p.text}
              onChange={(e) => updatePrompt(p.id, { text: e.target.value })}
              rows={3}
              className="mt-2 w-full resize-y rounded-[var(--radius)] border border-border bg-surface p-2 text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="outline" size="sm" onClick={addPrompt}>
          <Plus className="h-4 w-4" />
          Add prompt
        </Button>
        <Button variant="ghost" size="sm" onClick={() => persist(DEFAULT_PROMPTS)}>
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}
