# Citation styles and locales

These files come from the Citation Style Language project. They are used unchanged by Write
(`frontend/src/lib/citations.ts`) to format citations and reference lists.

- **Styles:** https://github.com/citation-style-language/styles
  - `apa.csl`: APA Style 7th edition
  - `harvard-cite-them-right.csl`: Cite Them Right 12th edition (Harvard)
  - `ieee.csl`: IEEE Reference Guide
  - `vancouver.csl`: NLM/Vancouver, Citing Medicine 2nd edition (citation-sequence); published there as `nlm-citation-sequence.csl`
  - `modern-language-association.csl`: MLA Handbook 9th edition
  - `chicago-author-date.csl`: Chicago Manual of Style 18th edition (author-date)
- **Locales:** https://github.com/citation-style-language/locales
  - `locales-en-GB.xml`
  - `locales-en-US.xml`

Licensed under the Creative Commons Attribution-ShareAlike 3.0 licence
(https://creativecommons.org/licenses/by-sa/3.0/). The authors of each style are named in its `<info>` block.

The formatting engine is citeproc-js (https://github.com/Juris-M/citeproc-js), used under the Common Public
Attribution License 1.0. Write shows "Citations by citeproc-js", with a link to its source.
