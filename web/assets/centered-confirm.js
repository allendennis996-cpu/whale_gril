// Shared viewport-centered confirmation for all pages.
window.centeredConfirm = function (message) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'position:fixed;inset:0;margin:auto;box-sizing:border-box;width:min(440px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;padding:24px;border:1px solid #28556e;border-radius:14px;background:#0b263a;color:#e1f3ff;box-shadow:0 16px 64px #0008;font:14px/1.6 system-ui,sans-serif;';
    const text = document.createElement('p');
    text.textContent = message;
    text.style.cssText = 'margin:0 0 24px;white-space:pre-wrap;overflow-wrap:anywhere;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;';
    const finish = (value) => { dialog.close(); dialog.remove(); resolve(value); };
    for (const [label, value] of [['确定', true], ['取消', false]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.style.cssText = 'padding:8px 20px;border:1px solid #39728b;border-radius:8px;background:#173e54;color:#e1f3ff;cursor:pointer;font:inherit;';
      button.onclick = () => finish(value);
      actions.append(button);
    }
    dialog.append(text, actions);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
    document.body.append(dialog);
    dialog.showModal();
  });
};
