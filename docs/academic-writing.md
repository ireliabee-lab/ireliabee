# Write: the academic writing framework

Approved by the owner on 12 October 2026. A screen of its own, **Write**, in the Think group, for any piece of academic or professional writing: an essay, a literature review, a research paper, a research proposal, a reflection or a report.

## Where the framework comes from

- **The stages and the checks** follow the University of Melbourne Academic Skills series "Academic Writing" (15 public videos). Each stage links to the videos that teach it. The guidance is paraphrased in `backend/writing_content/framework.json`; nothing is copied from the videos.
- **What that series doesn't cover** comes from standard frameworks:
  - IMRaD for research papers;
  - Swales' CARS moves for research introductions;
  - the usual research proposal structure;
  - the Manchester Academic Phrasebank's moves;
  - the citation style manuals (APA 7, Harvard, IEEE, Vancouver, MLA 9, Chicago author-date).

## The ten stages

1. Analyse the task
2. Choose your focus
3. Read and take notes
4. Plan the argument
5. Draft the body
6. Connect and sharpen your voice
7. Write the introduction and conclusion
8. Revise for style and clarity
9. Paraphrase and cite
10. Check and proofread

Each stage has a reason, what you produce, a checklist you tick, and its videos.

## The AI coaches, it never writes

The AI analyses, questions, points to what is weak and suggests patterns of phrasing. The words in the draft are always the writer's.

This is the owner's decision, made to keep users safe under university integrity and AI-use rules. No feature may generate or rewrite a user's paragraphs.

AI review is paid in credits, with the cost shown before each run. Before it ships, the Privacy Policy must name drafts among what can be sent (CLAUDE.md rule 7).

## Built in stages (one PR each, released together)

1. **Write screen:** projects, the six structures, word budgets and the ten-stage guide. Local only, no AI.
2. **Editor and planning:** the task analyser (direction, content and limiting words), the research question checks, the outline and budget.
3. **References:** a reference manager (from the Library, by DOI through Crossref, by hand), in-text citations, and the reference list in the six styles.
4. **Free checks:** sentence length, contractions, first person, vague words, a citation per paragraph, quote share, word limit, key terms. No AI.
5. **AI review:** paragraph structure, cohesion, critical voice, hedging, introduction moves and whether the conclusion concludes. Coach only, credits, cost first.
6. **Export:** Word (.docx), PDF and Markdown, with the reference list formatted.

## The citation backbone

Finding papers, citing as you write and citation cards are described, with their failure modes, in
[write-citation-backbone.md](write-citation-backbone.md). They use no AI.

## Storage

- Projects are kept in `writing_projects`, and their sections in `writing_sections` (`backend/writing.py`).
- Sections take their word target from the genre's share of the word limit, unless the writer sets one by hand.
- **Your data** export and import (`backend/transfer.py`) carry each project with its sections nested.
