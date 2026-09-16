/**
 * Builders for the JSON-LD the storefront publishes.
 *
 * Each takes the origin and the same data the page renders, so the schema and
 * the visible page cannot disagree. That is the pattern worth copying: schema
 * written by hand next to the markup drifts from it within a release or two,
 * and a schema that contradicts its page is treated by search as a reason to
 * distrust the whole thing.
 */

import { SITE_NAME, type Guide, type Product } from './data/catalog';

type Json = Record<string, unknown>;

const SCHEMA = 'https://schema.org';

const absolute = (origin: string, path: string): string => new URL(path, origin).href;

export function organizationSchema(origin: string): Json {
  return {
    '@context': SCHEMA,
    '@type': 'Organization',
    '@id': `${absolute(origin, '/')}#organization`,
    name: SITE_NAME,
    url: absolute(origin, '/'),
    logo: absolute(origin, '/favicon.svg'),
    sameAs: ['https://github.com/SudoDevStudio/astro-ai'],
  };
}

/**
 * The site itself. `potentialAction` is what makes a sitelinks search box
 * possible; without a target template it is decoration.
 */
export function websiteSchema(origin: string): Json {
  return {
    '@context': SCHEMA,
    '@type': 'WebSite',
    name: SITE_NAME,
    url: absolute(origin, '/'),
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${absolute(origin, '/shop/')}?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}

/**
 * A breadcrumb trail. The last crumb is the current page, so it carries no
 * `item` of its own — a link to where the reader already is.
 */
export function breadcrumbSchema(
  origin: string,
  trail: ReadonlyArray<{ name: string; path?: string }>,
): Json {
  return {
    '@context': SCHEMA,
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(({ name, path }, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name,
      ...(path === undefined ? {} : { item: absolute(origin, path) }),
    })),
  };
}

export function faqSchema(entries: ReadonlyArray<{ question: string; answer: string }>): Json {
  return {
    '@context': SCHEMA,
    '@type': 'FAQPage',
    mainEntity: entries.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };
}

/**
 * A product, with the offer that makes it eligible for a rich result.
 *
 * `sku` is deliberately not emitted here. It is one omission in one shared
 * template, which is exactly the shape the Site tab exists to find: three
 * product pages report it, and the cause is this function rather than the
 * pages.
 */
export function productSchema(origin: string, product: Product): Json {
  return {
    '@context': SCHEMA,
    '@type': 'Product',
    name: product.name,
    description: product.description,
    image: absolute(origin, product.image),
    url: absolute(origin, `/shop/${product.slug}/`),
    brand: { '@type': 'Brand', name: product.brand },
    offers: {
      '@type': 'Offer',
      price: product.price,
      priceCurrency: product.currency,
      availability: `${SCHEMA}/${product.availability}`,
      url: absolute(origin, `/shop/${product.slug}/`),
      seller: { '@type': 'Organization', name: SITE_NAME },
    },
    ...(product.rating === undefined
      ? {}
      : {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: product.rating.value,
            reviewCount: product.rating.count,
            bestRating: 5,
          },
        }),
  };
}

export function videoSchema(origin: string, product: Product): Json | undefined {
  if (product.video === undefined) return undefined;
  return {
    '@context': SCHEMA,
    '@type': 'VideoObject',
    name: product.video.name,
    description: product.video.description,
    thumbnailUrl: absolute(origin, product.image),
    uploadDate: product.video.uploadDate,
    duration: product.video.duration,
    contentUrl: absolute(origin, `/shop/${product.slug}/`),
  };
}

/** A collection page, which is what makes a carousel possible. */
export function itemListSchema(
  origin: string,
  items: ReadonlyArray<{ name: string; path: string }>,
): Json {
  return {
    '@context': SCHEMA,
    '@type': 'ItemList',
    itemListElement: items.map(({ name, path }, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name,
      url: absolute(origin, path),
    })),
  };
}

export function articleSchema(origin: string, guide: Guide): Json {
  return {
    '@context': SCHEMA,
    '@type': 'BlogPosting',
    headline: guide.title,
    description: guide.summary,
    image: absolute(origin, '/og/card.png'),
    url: absolute(origin, `/guides/${guide.slug}/`),
    datePublished: guide.published,
    dateModified: guide.updated,
    author: { '@type': 'Person', name: guide.author },
    publisher: { '@id': `${absolute(origin, '/')}#organization` },
    mainEntityOfPage: absolute(origin, `/guides/${guide.slug}/`),
  };
}

/** The physical counter, which is a different entity from the company. */
export function localBusinessSchema(origin: string): Json {
  return {
    '@context': SCHEMA,
    '@type': 'Store',
    name: `${SITE_NAME} Trade Counter`,
    url: absolute(origin, '/store/'),
    image: absolute(origin, '/og/card.png'),
    telephone: '+1 555 0100',
    priceRange: '$$',
    address: {
      '@type': 'PostalAddress',
      streetAddress: '1 Forge Lane',
      addressLocality: 'Sheffield',
      addressRegion: 'SY',
      postalCode: 'S1 2AB',
      addressCountry: 'US',
    },
    geo: { '@type': 'GeoCoordinates', latitude: 53.3811, longitude: -1.4701 },
    openingHoursSpecification: [
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        opens: '07:30',
        closes: '17:00',
      },
      { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Saturday', opens: '08:00', closes: '12:00' },
    ],
  };
}

export function jobPostingSchema(origin: string): Json {
  return {
    '@context': SCHEMA,
    '@type': 'JobPosting',
    title: 'Field Application Engineer',
    description:
      'Support customers specifying drives, cable and fall protection on site. Half the week is spent at customer premises and half writing the specifications that follow.',
    datePosted: '2026-08-30',
    validThrough: '2026-11-30',
    employmentType: 'FULL_TIME',
    hiringOrganization: { '@id': `${absolute(origin, '/')}#organization` },
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        streetAddress: '1 Forge Lane',
        addressLocality: 'Sheffield',
        addressRegion: 'SY',
        postalCode: 'S1 2AB',
        addressCountry: 'US',
      },
    },
    baseSalary: {
      '@type': 'MonetaryAmount',
      currency: 'USD',
      value: { '@type': 'QuantitativeValue', minValue: 68000, maxValue: 84000, unitText: 'YEAR' },
    },
  };
}
