// Programmatic workflow execution — the WorkflowPanel "Run all" loop, extracted
// so the chat "/" picker (SlashPicker) and the panel run a workflow through ONE
// execution path. Mirrors apps/web/lib/runWorkflow.ts (web persists with a
// userId; desktop's local SQLite `setWorkflowOutput` doesn't need one). Block
// outputs persist per meeting exactly as a manual "Run all" does, so a workflow
// launched from chat shows up in the meeting's Workflows tab.

import {
  setWorkflowOutput,
  type Workflow,
  type WorkflowBlock,
  type WorkflowSend,
} from "@/lib/lalela";
import { resolveLegacyModel } from "@/lib/settings";

export type GenerateFn = (user: string, system: string, model?: string) => Promise<string>;

/** Executes a send block's push and returns a human message. Injected so the
 * runner stays UI-neutral: the panel/chat pass a wrapper over `executeSend`.
 * Returning null means "not sent". */
export type WorkflowSendFn = (send: WorkflowSend) => Promise<string | null>;

/** Cap block input like the panel does — transcripts can be huge. */
export const WORKFLOW_INPUT_CHARS = 24000;

/** True when a block is a "send to MCP destination" block (T8). */
export function isSendBlock(block: WorkflowBlock): boolean {
  return block.type === "send" && !!block.send?.destination;
}

/** Thrown with the failing block so UIs can pin the error to it. */
export class WorkflowBlockError extends Error {
  blockId: string;
  constructor(blockId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.blockId = blockId;
  }
}

/**
 * Run every block top-to-bottom (the editor only allows earlier blocks as
 * inputs, so this order always satisfies dependencies). Prompt blocks run their
 * prompt; send blocks push the meeting to a connected MCP destination via the
 * injected `executeSend`. Returns block outputs by id; throws
 * WorkflowBlockError on the first failing block.
 *
 * Send-block confirmation (T8): an "ask"-mode send only runs when `confirmSend`
 * resolves true (interactive callers supply it). Without a `confirmSend` an
 * ask-mode send is skipped — it needs a human — while auto-mode sends run.
 */
export async function runWorkflow(args: {
  workflow: Workflow;
  transcriptText: string;
  meetingId: string;
  generate: GenerateFn;
  executeSend?: WorkflowSendFn;
  confirmSend?: (block: WorkflowBlock, send: WorkflowSend) => Promise<boolean>;
  onBlockStart?: (blockId: string) => void;
  onBlock?: (blockId: string, result: string) => void;
}): Promise<Map<string, string>> {
  const outputs = new Map<string, string>();
  for (const block of args.workflow.blocks) {
    args.onBlockStart?.(block.id);
    try {
      let result: string;
      if (isSendBlock(block)) {
        const send = block.send!;
        if (!args.executeSend) {
          result = "Not sent — sending isn't available here.";
        } else if (send.mode === "ask" && args.confirmSend && !(await args.confirmSend(block, send))) {
          result = "Not sent — you declined.";
        } else if (send.mode === "ask" && !args.confirmSend) {
          result = "Skipped — this ask-mode send needs confirmation.";
        } else {
          result = (await args.executeSend(send)) ?? "Not sent.";
        }
      } else {
        const input =
          block.input === "transcript" ? args.transcriptText : outputs.get(block.input);
        if (input === undefined) {
          throw new Error(`Block "${block.name}" depends on a block that has not run.`);
        }
        result = await args.generate(
          input.slice(0, WORKFLOW_INPUT_CHARS),
          block.prompt_text,
          block.model ? resolveLegacyModel(block.model) : undefined,
        );
      }
      outputs.set(block.id, result);
      await setWorkflowOutput(args.meetingId, args.workflow.id, block.id, result);
      args.onBlock?.(block.id, result);
    } catch (e) {
      if (e instanceof WorkflowBlockError) throw e;
      throw new WorkflowBlockError(block.id, e);
    }
  }
  return outputs;
}
