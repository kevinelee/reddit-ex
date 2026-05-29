'use strict';

const REDIRECT_KEY = 'rr_redirect';
const RULESET_ID   = 'redirect_rules';

// Apply saved preference on install and browser startup
chrome.runtime.onInstalled.addListener(applyRedirectSetting);
chrome.runtime.onStartup.addListener(applyRedirectSetting);

function applyRedirectSetting() {
  chrome.storage.local.get(REDIRECT_KEY, data => {
    // Default: enabled (true) if never set
    const enabled = data[REDIRECT_KEY] !== false;
    setRulesetEnabled(enabled);
  });
}

function setRulesetEnabled(enabled) {
  chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds:  enabled ? [RULESET_ID] : [],
    disableRulesetIds: enabled ? [] : [RULESET_ID],
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'rr_setRedirect') {
    const enabled = !!msg.enabled;
    chrome.storage.local.set({ [REDIRECT_KEY]: enabled });
    setRulesetEnabled(enabled);
    sendResponse({ ok: true });
  }
});
