import { MousePointer2 } from "lucide-react";

/**
 * Shown while the user's own assistant has been quiet on a step: assistants ask
 * permission before running a tool, and an unanswered prompt stalls the notes.
 * A small replay of that prompt shows the highlight moving to "Always allow"
 * and a click on it, so the user knows what to look for and what to choose.
 */
export default function ApprovalHint({ assistant }: { assistant: string }) {
  const options = ["Allow", "Allow for this session", "Always allow", "Cancel"];
  return (
    <div className="nb-approve" role="note">
      <div className="nb-approve-demo" aria-hidden="true">
        <div className="nb-approve-q">Allow the <b>ireliabee</b> MCP server to run tool "next_request"?</div>
        <ol className="nb-approve-opts">
          {options.map((o, i) => (
            <li key={o} className={i === 2 ? "target" : ""}><span>{i + 1}.</span> {o}</li>
          ))}
        </ol>
        <span className="nb-approve-hl" />
        <span className="nb-approve-cursor"><MousePointer2 size={16} /></span>
        <span className="nb-approve-ripple" />
      </div>
      <div className="nb-approve-text">
        <strong>Check {assistant}: it may be asking permission.</strong>
        <span>Choose <b>Always allow</b>. It asks once for <code>next_request</code> and once for <code>submit_answer</code>, then never again.</span>
      </div>
    </div>
  );
}
