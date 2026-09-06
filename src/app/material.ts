/**
 * Material Web components used across the app (Google's official M3 web
 * components). Importing registers the custom elements; the theme comes from
 * the --md-sys-color-* tokens in styles.css.
 */
import '@material/web/button/filled-button.js';
import '@material/web/button/filled-tonal-button.js';
import '@material/web/button/outlined-button.js';
import '@material/web/button/text-button.js';
import '@material/web/iconbutton/icon-button.js';
import '@material/web/fab/fab.js';
import '@material/web/textfield/outlined-text-field.js';
import '@material/web/select/outlined-select.js';
import '@material/web/select/select-option.js';
import '@material/web/checkbox/checkbox.js';
import '@material/web/radio/radio.js';
import '@material/web/switch/switch.js';
import '@material/web/dialog/dialog.js';
import '@material/web/progress/linear-progress.js';
import '@material/web/progress/circular-progress.js';
import '@material/web/ripple/ripple.js';
import '@material/web/divider/divider.js';
import '@material/web/icon/icon.js';
import '@material/web/chips/chip-set.js';
import '@material/web/chips/assist-chip.js';
import '@material/web/chips/filter-chip.js';
import { styles as typescaleStyles } from '@material/web/typography/md-typescale-styles.js';

if (typescaleStyles.styleSheet) document.adoptedStyleSheets = [...document.adoptedStyleSheets, typescaleStyles.styleSheet];

/**
 * Touch feedback everywhere a row or tile is tappable: give it a ripple once.
 * Called after every render.
 */
export function addRipples(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('.clickable, .txn .who, a.list-item, .tabbar a .icon, .stat[data-action]')) {
    if (el.querySelector(':scope > md-ripple')) continue;
    const r = document.createElement('md-ripple');
    el.appendChild(r);
  }
}
