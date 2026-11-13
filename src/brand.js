/**
 * The product's name. The builder page writes it into the wordmark and the
 * page title, and the site build (bin/build-site.js) writes it into the
 * entry page's title and link. It is written nowhere else, so a new name is
 * a change to this one string.
 *
 * This module has no Node or browser dependencies.
 */
export const NAME = 'Agent PFP';

/**
 * The page title for a name.
 * @param {string} name
 */
export function pageTitle(name) {
  return `${name} builder`;
}
