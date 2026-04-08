// Disable session restore so Firefox always opens the command-line URL
user_pref("browser.sessionstore.enabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.sessionstore.resume_session_once", false);
// Open blank on startup; the command-line URL takes over
user_pref("browser.startup.page", 0);
// Kill all first-run / welcome / import prompts
user_pref("datareporting.policy.firstRunURL", "");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
user_pref("browser.aboutwelcome.enabled", false);
// White content background so Firefox blends with the root window during startup
user_pref("browser.display.background_color", "#ffffff");
// Disable telemetry noise
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
