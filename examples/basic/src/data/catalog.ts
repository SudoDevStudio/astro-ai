/**
 * The storefront's data, in one place.
 *
 * Stands in for a commerce API. Every page that renders one of these also
 * declares structured data built from the same values, which is the point: a
 * schema assembled from the data the page already renders cannot drift from
 * what the reader sees, and a schema that disagrees with its page is one of the
 * things the share preview reports.
 */

export type Product = {
  slug: string;
  name: string;
  summary: string;
  description: string;
  price: string;
  currency: string;
  /** A schema.org availability value, without the vocabulary prefix. */
  availability: 'InStock' | 'OutOfStock' | 'PreOrder' | 'BackOrder';
  brand: string;
  rating?: { value: number; count: number };
  image: string;
  imageAlt: string;
  specifications: Array<{ label: string; value: string }>;
  faq: Array<{ question: string; answer: string }>;
  /** Only the flagship has one, so the VideoObject rules can be seen firing. */
  video?: { name: string; description: string; duration: string; uploadDate: string };
};

export type Guide = {
  slug: string;
  title: string;
  summary: string;
  body: string[];
  author: string;
  published: string;
  updated: string;
  faq: Array<{ question: string; answer: string }>;
};

export const SITE_NAME = 'Acme Tools';

export const products: Product[] = [
  {
    slug: 'torque-wrench',
    name: 'Torque Wrench 200Nm',
    summary: 'Calibrated to 200 Nm, with a certificate valid for twelve months.',
    description:
      'A click-type torque wrench covering 20 to 200 Nm in 1 Nm increments, supplied with a calibration certificate valid for twelve months and a moulded case. The mechanism is rated for 5,000 cycles between recalibrations.',
    price: '189.00',
    currency: 'USD',
    availability: 'InStock',
    brand: 'Acme Tools',
    rating: { value: 4.6, count: 128 },
    image: '/og/card.png',
    imageAlt: 'Abstract share card for the astro-ai example',
    specifications: [
      { label: 'Range', value: '20–200 Nm' },
      { label: 'Increment', value: '1 Nm' },
      { label: 'Accuracy', value: '±3% clockwise' },
      { label: 'Drive', value: '1/2 inch square' },
    ],
    faq: [
      {
        question: 'What torque range does it cover?',
        answer: '20 to 200 Nm, in 1 Nm increments.',
      },
      {
        question: 'How often does it need recalibrating?',
        answer: 'Once a year, or after any drop. The supplied certificate is valid for twelve months.',
      },
      {
        question: 'Does it come with a case?',
        answer: 'Yes, a moulded case is included at no extra cost.',
      },
    ],
    video: {
      name: 'Setting and releasing a click-type torque wrench',
      description: 'A two minute walkthrough of setting the scale, taking a reading, and winding the wrench back down for storage.',
      duration: 'PT2M14S',
      uploadDate: '2026-02-11',
    },
  },
  {
    slug: 'cable-spool',
    name: 'Shielded VFD Cable, 100 m',
    summary: 'Shielded four-core cable for variable frequency drives, on a 100 m spool.',
    description:
      'Four-core shielded cable rated for variable frequency drive installations, supplied on a 100 metre spool. The braid gives 85% coverage, which keeps drive noise inside the run rather than in everything near it.',
    price: '340.00',
    currency: 'USD',
    availability: 'InStock',
    brand: 'Acme Tools',
    rating: { value: 4.2, count: 41 },
    image: '/og/card.png',
    imageAlt: 'Abstract share card for the astro-ai example',
    specifications: [
      { label: 'Cores', value: '4 × 2.5 mm²' },
      { label: 'Shield', value: 'Braid, 85% coverage' },
      { label: 'Length', value: '100 m' },
      { label: 'Rating', value: '0.6/1 kV' },
    ],
    faq: [
      {
        question: 'Is the shield rated for VFD installations?',
        answer: 'Yes. The braid gives 85% coverage, which is what a drive run needs to stay inside its own conduit.',
      },
      {
        question: 'Can it be cut to length?',
        answer: 'Spools are supplied whole. Cut lengths are a separate line we do not stock online.',
      },
    ],
  },
  {
    slug: 'safety-harness',
    name: 'Full Body Safety Harness, Size L',
    summary: 'Five-point full body harness with a dorsal D-ring, size large.',
    description:
      'A five-point full body harness with a dorsal D-ring and two side positioning rings, in size large. Webbing is inspected and date-stamped at manufacture, and the harness should be withdrawn from service five years from that date.',
    price: '215.00',
    currency: 'USD',
    availability: 'BackOrder',
    brand: 'Acme Tools',
    image: '/og/card.png',
    imageAlt: 'Abstract share card for the astro-ai example',
    specifications: [
      { label: 'Size', value: 'Large' },
      { label: 'Attachment', value: 'Dorsal D-ring, two side rings' },
      { label: 'Service life', value: '5 years from date stamp' },
      { label: 'Standard', value: 'EN 361' },
    ],
    faq: [
      {
        question: 'How long can a harness stay in service?',
        answer: 'Five years from the date stamped on the webbing, assuming it passes inspection and has arrested no fall.',
      },
      {
        question: 'What happens after a fall arrest?',
        answer: 'The harness is withdrawn immediately and destroyed. A harness that has arrested a fall is never returned to service.',
      },
    ],
  },
];

export const guides: Guide[] = [
  {
    slug: 'specifying-a-torque-wrench',
    title: 'Specifying a torque wrench',
    summary: 'How to pick a range, an accuracy class, and a recalibration interval you will actually keep to.',
    body: [
      'A torque wrench is specified by three numbers and one habit. The numbers are the range, the increment, and the accuracy class. The habit is recalibration, and it is the one most buying decisions ignore.',
      'Pick a range where your working torque sits between 20% and 80% of full scale. A wrench used near the bottom of its range is the usual source of a reading nobody trusts, because click mechanisms are least repeatable there.',
      'Accuracy is quoted as a percentage of the reading, not of full scale, and clockwise and counter-clockwise figures differ. A wrench quoted at ±3% clockwise may be ±6% the other way, which matters on any fastener you will later loosen to a specification.',
    ],
    author: 'A. Category Manager',
    published: '2026-03-04',
    updated: '2026-03-18',
    faq: [
      {
        question: 'What range should I buy?',
        answer: 'One where your working torque falls between 20% and 80% of full scale.',
      },
      {
        question: 'Is accuracy the same in both directions?',
        answer: 'No. Counter-clockwise accuracy is usually about half as good, and is quoted separately.',
      },
    ],
  },
  {
    slug: 'when-to-retire-a-harness',
    title: 'When to retire a safety harness',
    summary: 'The three conditions that end a harness’s service life, and the one that ends it immediately.',
    body: [
      'A harness leaves service for one of three reasons: it reaches its date, it fails an inspection, or it arrests a fall. The third is not a judgement call.',
      'Date is the easiest to administer. Webbing is stamped at manufacture and the harness is withdrawn five years from that stamp, whatever its apparent condition, because the degradation that matters is in fibres you cannot see.',
      'Inspection is the one that needs training. Cuts, abrasion, heat glazing, chemical staining and distorted hardware are all withdrawal conditions, and any one of them ends the harness regardless of its date.',
    ],
    author: 'A. Safety Lead',
    published: '2026-01-22',
    updated: '2026-02-09',
    faq: [
      {
        question: 'Can a harness be repaired?',
        answer: 'No. Webbing and hardware are not field-repairable; a harness that fails inspection is destroyed.',
      },
      {
        question: 'Does a harness that arrested a fall get inspected or destroyed?',
        answer: 'Destroyed. Inspection does not return it to service.',
      },
    ],
  },
];

export function productBySlug(slug: string): Product {
  const product = products.find((entry) => entry.slug === slug);
  if (product === undefined) throw new Error(`No product named ${slug}.`);
  return product;
}
