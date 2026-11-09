// react-dom.mjs: re-exports from the one bundled React 19.2.9 (vendor-kd.mjs)
import { ReactDOM as M } from './react-all.mjs';
export default M;
export const { __DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, createPortal, flushSync, preconnect, prefetchDNS, preinit, preinitModule, preload, preloadModule, requestFormReset, unstable_batchedUpdates, useFormState, useFormStatus, version } = M;
