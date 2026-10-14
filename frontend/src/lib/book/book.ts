import type { Block, PageContent } from './typeset';

export type PageSpec =
  | { readonly kind: 'cover' }
  | { readonly kind: 'endpaper' }
  | { readonly kind: 'title' }
  /** `folio` is the printed page number; defaults to the physical position. */
  | { readonly kind: 'text'; readonly content: PageContent; readonly folio?: number }
  | { readonly kind: 'colophon' }
  | { readonly kind: 'blank'; readonly folio?: number }
  | { readonly kind: 'back-cover' }
  /** An app-specific page, painted by a custom painter (plain paper by default). */
  | { readonly kind: 'custom'; readonly name: string; readonly data?: Readonly<Record<string, string>> };

export const BOOK_TITLE = 'The Cartographer of Small Rains';

export const STORY: readonly Block[] = [
  { kind: 'chapter', numeral: 'I', title: 'The map with no roads' },
  {
    kind: 'para',
    text: 'In the town of Halden, where the hills folded into one another like sleeping dogs, there lived a cartographer named Ines Varo who had never once drawn a road. Roads, she said, were the business of surveyors and tax collectors. Her business was weather, and in particular the small rains: the ones that fell on a single garden and not its neighbour, the ones that followed a funeral to the edge of town and then politely stopped.',
  },
  {
    kind: 'para',
    text: 'She kept her maps in long drawers that smelled of cedar and wet paper. Each sheet showed the town from above, drawn in brown ink, and over it she laid thin washes of blue wherever a small rain had fallen that day. Some sheets were nearly bare. Others were so heavily washed that the town beneath them looked as if it were sinking into a lake.',
  },
  {
    kind: 'para',
    text: 'People came to her for reasons they rarely admitted. A baker wanted to know whether the rain that always found his roof was a curse. A widow asked whether it had rained on her husband’s grave on the morning she forgot to visit. Ines answered each of them the same way. She pulled out the right drawer, found the right day, and let them look.',
  },
  {
    kind: 'para',
    text: '“It isn’t a prophecy,” she would say. “It’s a record. The sky keeps its own accounts. I only copy them out.”',
  },
  { kind: 'chapter', numeral: 'II', title: 'The boy who brought a cloud' },
  {
    kind: 'para',
    text: 'In the spring of her sixty-first year, a boy arrived at her door holding a glass jar with its lid screwed tight. Inside, pressed against the glass like a moth, was a cloud no bigger than a fist. It was grey at the bottom and white at the top, and every so often it let fall a few drops that ran down the inside of the jar and vanished before they reached the base.',
  },
  {
    kind: 'para',
    text: '“It followed me from the coast,” the boy said. “It rains on me every morning. Only me. My mother says it’s bad luck and I should let it go, but whenever I open the lid it just waits.”',
  },
  {
    kind: 'para',
    text: 'Ines set the jar on her drafting table and looked at it for a long time. In forty years of mapping she had drawn thousands of small rains, but she had never seen one that stayed so close to its source. Most of them wandered. Most of them forgot.',
  },
  { kind: 'para', text: '“What’s your name?” she asked.' },
  { kind: 'para', text: '“Tomas.”' },
  {
    kind: 'para',
    text: '“Well, Tomas, I think your cloud is lost. And lost things usually follow the last kind person they met.”',
  },
  { kind: 'para', text: 'The boy considered this. “I gave it water,” he admitted. “On the beach. It looked thin.”' },
  {
    kind: 'para',
    text: 'For the next nine days Tomas came every morning, and Ines drew his cloud’s rain on a fresh sheet: a single blue thread that started at his house, wound through the market, crossed the bridge, and ended at her door. By the ninth day the thread had grown thicker, and the cloud had grown too heavy for its jar.',
  },
  { kind: 'chapter', numeral: 'III', title: 'Where the rain wanted to go' },
  {
    kind: 'para',
    text: 'On the tenth morning, Ines laid all nine sheets on top of one another and held them up to the window. The blue threads did not lie in the same place. Each day the rain had drifted a little further west, as if pulled by something the boy could not feel.',
  },
  {
    kind: 'para',
    text: '“It isn’t following you,” she said slowly. “It’s trying to get somewhere, and you’re the only road it trusts.”',
  },
  {
    kind: 'para',
    text: 'They walked west together, past the last houses and into the hills, the jar held between them. Near the top of the third hill they found a hollow where the grass had turned yellow and the old well was dry. Tomas unscrewed the lid.',
  },
  {
    kind: 'para',
    text: 'The cloud rose, stretched, and seemed to look around. Then it settled over the hollow and rained, properly this time, for most of an hour. When it was done there was nothing left of it but a brightness in the air and the sound of water finding its way down into the stone.',
  },
  {
    kind: 'para',
    text: 'That evening Ines unrolled a new sheet and drew the hills, the hollow and the well. Then, for the first time in her life, she drew a road: a thin dotted line from the town to the hollow, so that anyone who came after would know the way.',
  },
  { kind: 'para', text: 'Tomas asked her why.' },
  { kind: 'para', text: '“Because some rains need help getting home,” she said, and blotted the ink.' },
];

/**
 * Assembles the physical page order. Index 0 is the front cover (a right-hand
 * page); the result always has an even length so the back cover lands on the
 * left of the final spread.
 */
export function assemblePages(textPages: readonly PageContent[]): PageSpec[] {
  const pages: PageSpec[] = [{ kind: 'cover' }, { kind: 'endpaper' }, { kind: 'title' }];
  for (const content of textPages) pages.push({ kind: 'text', content });
  pages.push({ kind: 'colophon' });
  // Endpaper + back cover follow; pad so the back cover sits at an odd index.
  if ((pages.length + 2) % 2 !== 0) pages.push({ kind: 'blank' });
  pages.push({ kind: 'endpaper' }, { kind: 'back-cover' });
  return pages;
}
