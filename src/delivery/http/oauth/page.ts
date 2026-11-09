export type AuthorizationPageData = {
  uid: string;
  csrf: string;
  clientName: string;
  scopes: readonly string[];
  selectedScopes?: readonly string[];
  requireCode: boolean;
  error?: string;
};

export function renderAuthorizationPage(data: AuthorizationPageData): string {
  const selected = new Set(data.selectedScopes ?? data.scopes);
  const scopeRows = data.scopes
    .map(
      (scope) => `<label class="scope">
        <input type="checkbox" name="scope" value="${html(scope)}"${
          selected.has(scope) ? " checked" : ""
        }>
        <span><strong>${html(scope)}</strong><small>${html(scopeDescription(scope))}</small></span>
      </label>`
    )
    .join("");
  return htmlDocument(
    "Authorize Thebe",
    `<main>
      <header>
        <div class="mark" aria-hidden="true">T</div>
        <div><p class="eyebrow">Thebe access request</p><h1>${html(data.clientName)}</h1></div>
      </header>
      ${data.error ? `<p class="error" role="alert">${html(data.error)}</p>` : ""}
      <form method="post" action="/oauth/interaction/${encodeURIComponent(data.uid)}">
        <input type="hidden" name="csrf" value="${html(data.csrf)}">
        ${
          data.requireCode
            ? `<label class="code">One-time pairing code
                <input name="code" autocomplete="one-time-code" inputmode="text" spellcheck="false" required autofocus>
              </label>`
            : ""
        }
        <fieldset>
          <legend>Requested access</legend>
          ${scopeRows}
        </fieldset>
        <div class="actions">
          <button class="secondary" type="submit" name="decision" value="deny">Deny</button>
          <button type="submit" name="decision" value="approve">Authorize</button>
        </div>
      </form>
    </main>`
  );
}

export function renderOAuthMessage(
  title: string,
  message: string,
  status = "400 Bad Request"
): string {
  return htmlDocument(
    title,
    `<main><header><div class="mark" aria-hidden="true">T</div><div><p class="eyebrow">Thebe OAuth</p><h1>${html(
      title
    )}</h1></div></header><p class="error" role="alert">${html(
      message
    )}</p><p class="status">${html(status)}</p></main>`
  );
}

function htmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${html(title)}</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f5f3; color: #17221d; }
    main { width: min(560px, calc(100vw - 32px)); padding: 28px; background: #fff; border: 1px solid #d8ded9; border-radius: 8px; box-shadow: 0 18px 50px rgba(25, 45, 34, .09); }
    header { display: flex; gap: 14px; align-items: center; margin-bottom: 24px; }
    .mark { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 8px; background: #164e3b; color: #fff; font-weight: 750; }
    h1 { margin: 2px 0 0; font-size: 1.55rem; line-height: 1.2; overflow-wrap: anywhere; }
    .eyebrow { margin: 0; color: #65736a; font-size: .76rem; font-weight: 700; text-transform: uppercase; }
    form { display: grid; gap: 20px; }
    fieldset { margin: 0; padding: 0; border: 0; }
    legend, .code { display: block; margin-bottom: 10px; color: #405047; font-size: .84rem; font-weight: 700; }
    .scope { display: flex; gap: 11px; align-items: flex-start; padding: 11px 0; border-top: 1px solid #edf0ed; }
    .scope input { margin-top: 3px; accent-color: #164e3b; }
    .scope span { display: grid; gap: 2px; }
    .scope strong { font: 600 .9rem ui-monospace, SFMono-Regular, Menlo, monospace; }
    .scope small { color: #68766d; font-size: .8rem; }
    .code input { display: block; width: 100%; margin-top: 8px; padding: 11px 12px; border: 1px solid #aeb9b0; border-radius: 6px; font: 650 1rem ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; }
    .code input:focus { outline: 3px solid rgba(22, 78, 59, .18); border-color: #164e3b; }
    .actions { display: flex; justify-content: flex-end; gap: 10px; }
    button { min-width: 112px; padding: 10px 14px; border: 1px solid #164e3b; border-radius: 6px; background: #164e3b; color: #fff; font-weight: 700; cursor: pointer; }
    button.secondary { border-color: #cbd3cd; background: #fff; color: #29372f; }
    button:focus-visible { outline: 3px solid rgba(22, 78, 59, .25); outline-offset: 2px; }
    .error { margin: 0 0 18px; padding: 10px 12px; border: 1px solid #e2b7ad; border-radius: 6px; background: #fff2ef; color: #822f20; font-size: .88rem; }
    .status { color: #68766d; font-size: .8rem; }
    @media (max-width: 480px) { main { padding: 22px; } .actions { display: grid; grid-template-columns: 1fr 1fr; } button { min-width: 0; } }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function scopeDescription(scope: string): string {
  switch (scope) {
    case "mcp:read":
      return "Read home status and available tools.";
    case "mcp:write":
      return "Run actions that change devices and services.";
    case "mcp:irreversible":
      return "Run deletes that cannot be undone.";
    case "offline_access":
      return "Stay connected after this browser session ends.";
    default:
      return "Requested OAuth permission.";
  }
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
