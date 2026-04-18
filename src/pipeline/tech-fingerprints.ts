import type { TechStackSignals } from "../models/audit.js";

// Signal kinds:
//   - html-regex: matches against the (truncated) response body
//   - header: matches against response header values
//   - cookie: matches against Set-Cookie names (substring, case-insensitive)
// Every fingerprint declares AT LEAST TWO signals so a single coincidental
// match (e.g., the word "WordPress" appearing in an article) does not flip
// the whole site into the CMS bucket. Detection requires >= 2 matches.

export type FingerprintBucket = keyof TechStackSignals;

export interface HtmlRegexSignal {
  kind: "html-regex";
  pattern: RegExp;
}

export interface HeaderSignal {
  kind: "header";
  name: string;
  pattern: RegExp;
}

export interface CookieSignal {
  kind: "cookie";
  namePattern: RegExp;
}

export type FingerprintSignal =
  | HtmlRegexSignal
  | HeaderSignal
  | CookieSignal;

export interface Fingerprint {
  id: string;
  bucket: FingerprintBucket;
  signals: FingerprintSignal[];
}

const html = (pattern: RegExp): HtmlRegexSignal => ({
  kind: "html-regex",
  pattern,
});
const header = (name: string, pattern: RegExp): HeaderSignal => ({
  kind: "header",
  name: name.toLowerCase(),
  pattern,
});
const cookie = (namePattern: RegExp): CookieSignal => ({
  kind: "cookie",
  namePattern,
});

// --- CMS --------------------------------------------------------------------

const CMS: Fingerprint[] = [
  {
    id: "wordpress",
    bucket: "cms",
    signals: [
      html(/wp-content\//i),
      html(/wp-includes\//i),
      html(/<meta\s+name=["']generator["']\s+content=["']WordPress/i),
      cookie(/wordpress_logged_in/i),
      cookie(/wp-settings/i),
    ],
  },
  {
    id: "joomla",
    bucket: "cms",
    signals: [
      html(/<meta\s+name=["']generator["']\s+content=["']Joomla/i),
      html(/\/media\/jui\//i),
      html(/\/components\/com_/i),
      cookie(/joomla_user_state/i),
    ],
  },
  {
    id: "drupal",
    bucket: "cms",
    signals: [
      html(/<meta\s+name=["']generator["']\s+content=["']Drupal/i),
      html(/\/sites\/all\/(?:modules|themes)\//i),
      html(/\/sites\/default\/files\//i),
      header("x-generator", /Drupal/i),
    ],
  },
  {
    id: "typo3",
    bucket: "cms",
    signals: [
      html(/<meta\s+name=["']generator["']\s+content=["']TYPO3/i),
      html(/typo3conf\//i),
      html(/typo3temp\//i),
    ],
  },
  {
    id: "contao",
    bucket: "cms",
    signals: [
      html(/<meta\s+name=["']generator["']\s+content=["']Contao/i),
      html(/\/bundles\/contao/i),
      html(/\/files\/tx_contao/i),
    ],
  },
  {
    id: "wix",
    bucket: "cms",
    signals: [
      html(/<meta[^>]+content=["'][^"']*Wix\.com/i),
      html(/static\.wixstatic\.com/i),
      html(/X-Wix-Request-Id/i),
      header("x-wix-request-id", /.+/),
      header("server", /wix/i),
    ],
  },
  {
    id: "squarespace",
    bucket: "cms",
    signals: [
      html(/static1\.squarespace\.com/i),
      html(/<meta[^>]+content=["']Squarespace/i),
      header("x-contextid", /.+/),
      cookie(/crumb/i),
    ],
  },
  {
    id: "jimdo",
    bucket: "cms",
    signals: [
      html(/<meta[^>]+content=["']Jimdo/i),
      html(/assets\.jimstatic\.com/i),
      html(/jimdofree\.com/i),
    ],
  },
  {
    id: "shopify",
    bucket: "cms",
    signals: [
      html(/cdn\.shopify\.com/i),
      html(/Shopify\.theme/i),
      html(/<meta[^>]+content=["']Shopify/i),
      header("x-shopify-stage", /.+/),
      header("x-shardid", /.+/),
      cookie(/_shopify_/i),
    ],
  },
  {
    id: "webflow",
    bucket: "cms",
    signals: [
      html(/<meta[^>]+content=["']Webflow/i),
      html(/assets\.website-files\.com/i),
      html(/data-wf-site=/i),
      html(/data-wf-page=/i),
    ],
  },
  {
    id: "hubspot",
    bucket: "cms",
    signals: [
      html(/<meta[^>]+content=["']HubSpot/i),
      html(/js\.hs-scripts\.com/i),
      html(/js\.hs-analytics\.net/i),
      cookie(/hubspotutk/i),
    ],
  },
  {
    id: "prestashop",
    bucket: "cms",
    signals: [
      html(/<meta\s+name=["']generator["']\s+content=["']PrestaShop/i),
      html(/\/modules\/prestashop/i),
      html(/prestashop\s*=\s*\{/i),
      cookie(/PrestaShop-[a-f0-9]/i),
    ],
  },
  {
    id: "magento",
    bucket: "cms",
    signals: [
      html(/Mage\.Cookies/i),
      html(/\/skin\/frontend\//i),
      html(/\/mage\//i),
      cookie(/frontend_cid/i),
      cookie(/X-Magento-Vary/i),
    ],
  },
];

// --- Page Builders ----------------------------------------------------------

const PAGE_BUILDERS: Fingerprint[] = [
  {
    id: "elementor",
    bucket: "pageBuilder",
    signals: [
      html(/elementor-(?:frontend|pro)/i),
      html(/\/wp-content\/plugins\/elementor/i),
      html(/class=["'][^"']*elementor-/i),
      html(/<meta\s+name=["']generator["']\s+content=["']Elementor/i),
    ],
  },
  {
    id: "divi",
    bucket: "pageBuilder",
    signals: [
      html(/\/wp-content\/themes\/Divi/i),
      html(/et_pb_section/i),
      html(/et_pb_row/i),
      html(/divi-module/i),
    ],
  },
  {
    id: "oxygen",
    bucket: "pageBuilder",
    signals: [
      html(/\/wp-content\/plugins\/oxygen/i),
      html(/oxy-[a-z]+-\d+/i),
      html(/ct_builder/i),
    ],
  },
  {
    id: "beaver-builder",
    bucket: "pageBuilder",
    signals: [
      html(/\/wp-content\/plugins\/bb-plugin/i),
      html(/fl-builder-content/i),
      html(/fl-node-/i),
    ],
  },
  {
    id: "visual-composer",
    bucket: "pageBuilder",
    signals: [
      html(/\/js_composer\//i),
      html(/vc_row/i),
      html(/vc_column/i),
    ],
  },
  {
    id: "gutenberg",
    bucket: "pageBuilder",
    signals: [
      html(/wp-block-library/i),
      html(/class=["'][^"']*wp-block-/i),
      html(/has-text-align-/i),
    ],
  },
];

// --- Analytics --------------------------------------------------------------

const ANALYTICS: Fingerprint[] = [
  {
    id: "google-analytics",
    bucket: "analytics",
    signals: [
      html(/googletagmanager\.com\/gtag\/js/i),
      html(/google-analytics\.com\/analytics\.js/i),
      html(/ga\(['"]create['"]/i),
      html(/gtag\(['"]config['"],\s*['"]G-[A-Z0-9]+/i),
      html(/gtag\(['"]config['"],\s*['"]UA-\d+/i),
      cookie(/^_ga/i),
      cookie(/_gid/i),
    ],
  },
  {
    id: "matomo",
    bucket: "analytics",
    signals: [
      html(/matomo\.js/i),
      html(/piwik\.js/i),
      html(/var\s+_paq\s*=/i),
      cookie(/_pk_id/i),
      cookie(/_pk_ses/i),
    ],
  },
  {
    id: "plausible",
    bucket: "analytics",
    signals: [
      html(/plausible\.io\/js\//i),
      html(/data-domain=["'][^"']+["']\s+src=["'][^"']*plausible/i),
      html(/plausible\.io\/api\/event/i),
    ],
  },
  {
    id: "fathom",
    bucket: "analytics",
    signals: [
      html(/cdn\.usefathom\.com/i),
      html(/data-site=["'][A-Z]{8}["']/),
      html(/usefathom\.com\/script\.js/i),
    ],
  },
  {
    id: "cloudflare-web-analytics",
    bucket: "analytics",
    signals: [
      html(/static\.cloudflareinsights\.com\/beacon\.min\.js/i),
      html(/__cfBeacon/i),
      html(/cloudflareinsights\.com/i),
    ],
  },
];

// --- Tracking / Marketing ---------------------------------------------------

const TRACKING: Fingerprint[] = [
  {
    id: "facebook-pixel",
    bucket: "tracking",
    signals: [
      html(/connect\.facebook\.net\/[a-z_]+\/fbevents\.js/i),
      html(/fbq\(['"]init['"]/i),
      html(/www\.facebook\.com\/tr\?id=/i),
      cookie(/^_fbp/i),
    ],
  },
  {
    id: "google-tag-manager",
    bucket: "tracking",
    signals: [
      html(/googletagmanager\.com\/gtm\.js/i),
      html(/GTM-[A-Z0-9]+/),
      html(/dataLayer\s*=\s*dataLayer/i),
    ],
  },
  {
    id: "google-ads",
    bucket: "tracking",
    signals: [
      html(/googleadservices\.com\/pagead/i),
      html(/gtag\(['"]config['"],\s*['"]AW-\d+/i),
      html(/googleads\.g\.doubleclick\.net/i),
      cookie(/^_gcl_/i),
    ],
  },
  {
    id: "linkedin-insight",
    bucket: "tracking",
    signals: [
      html(/snap\.licdn\.com\/li\.lms-analytics/i),
      html(/_linkedin_partner_id/i),
      html(/px\.ads\.linkedin\.com/i),
    ],
  },
  {
    id: "tiktok-pixel",
    bucket: "tracking",
    signals: [
      html(/analytics\.tiktok\.com\/i18n\/pixel/i),
      html(/ttq\.load\(['"][A-Z0-9]+/),
      html(/tiktok\.com\/pixel/i),
    ],
  },
  {
    id: "hotjar",
    bucket: "tracking",
    signals: [
      html(/static\.hotjar\.com\/c\/hotjar-/i),
      html(/hjid:\s*\d+/i),
      html(/_hjSettings/i),
      cookie(/_hjSession/i),
      cookie(/_hjid/i),
    ],
  },
  {
    id: "mouseflow",
    bucket: "tracking",
    signals: [
      html(/cdn\.mouseflow\.com/i),
      html(/mouseflow.*?apikey/i),
      html(/_mfq\s*=/i),
    ],
  },
];

// --- Payment ----------------------------------------------------------------

const PAYMENT: Fingerprint[] = [
  {
    id: "stripe",
    bucket: "payment",
    signals: [
      html(/js\.stripe\.com\/v\d/i),
      html(/Stripe\(['"]pk_(?:live|test)_/i),
      html(/checkout\.stripe\.com/i),
      cookie(/__stripe_mid/i),
      cookie(/__stripe_sid/i),
    ],
  },
  {
    id: "paypal",
    bucket: "payment",
    signals: [
      html(/www\.paypal\.com\/sdk\/js/i),
      html(/paypal\.Buttons\(/i),
      html(/paypalobjects\.com/i),
      html(/paypal-button/i),
    ],
  },
  {
    id: "klarna",
    bucket: "payment",
    signals: [
      html(/x\.klarnacdn\.net/i),
      html(/js\.klarna\.com/i),
      html(/klarna-placement/i),
    ],
  },
  {
    id: "mollie",
    bucket: "payment",
    signals: [
      html(/js\.mollie\.com/i),
      html(/mollie\.createToken/i),
      html(/mollie-component/i),
    ],
  },
  {
    id: "adyen",
    bucket: "payment",
    signals: [
      html(/checkoutshopper-live\.adyen\.com/i),
      html(/AdyenCheckout\(/i),
      html(/adyen\.com\/hpp/i),
    ],
  },
  {
    id: "shopify-pay",
    bucket: "payment",
    signals: [
      html(/shop\.app\/pay/i),
      html(/shopify\.com\/checkouts/i),
      html(/shopify-payment-button/i),
    ],
  },
];

// --- CDN --------------------------------------------------------------------

const CDN: Fingerprint[] = [
  {
    id: "cloudflare",
    bucket: "cdn",
    signals: [
      header("server", /cloudflare/i),
      header("cf-ray", /.+/),
      header("cf-cache-status", /.+/),
      cookie(/__cfduid/i),
      cookie(/__cf_bm/i),
    ],
  },
  {
    id: "fastly",
    bucket: "cdn",
    signals: [
      header("x-served-by", /cache-/i),
      header("x-fastly-request-id", /.+/),
      header("fastly-debug-digest", /.+/),
      header("x-cache", /HIT|MISS/i),
    ],
  },
  {
    id: "akamai",
    bucket: "cdn",
    signals: [
      header("x-akamai-transformed", /.+/),
      header("akamai-grn", /.+/),
      header("server", /AkamaiGHost/i),
    ],
  },
  {
    id: "aws-cloudfront",
    bucket: "cdn",
    signals: [
      header("x-amz-cf-id", /.+/),
      header("via", /CloudFront/i),
      header("x-cache", /cloudfront/i),
    ],
  },
  {
    id: "netlify",
    bucket: "cdn",
    signals: [
      header("server", /Netlify/i),
      header("x-nf-request-id", /.+/),
      header("x-served-by-netlify", /.+/),
    ],
  },
  {
    id: "vercel",
    bucket: "cdn",
    signals: [
      header("server", /Vercel/i),
      header("x-vercel-id", /.+/),
      header("x-vercel-cache", /.+/),
    ],
  },
  {
    id: "github-pages",
    bucket: "cdn",
    signals: [
      header("server", /GitHub\.com/i),
      header("x-github-request-id", /.+/),
      html(/<meta\s+name=["']generator["']\s+content=["']Jekyll/i),
    ],
  },
];

export const FINGERPRINTS: readonly Fingerprint[] = [
  ...CMS,
  ...PAGE_BUILDERS,
  ...ANALYTICS,
  ...TRACKING,
  ...PAYMENT,
  ...CDN,
];

// Require at least this many distinct signals to match before a fingerprint
// registers. 2 is a strong floor against false positives — the word "Joomla"
// appearing in a blog post about web platforms would no longer, by itself,
// flip the site into the Joomla bucket.
export const MIN_MATCHES = 2;
