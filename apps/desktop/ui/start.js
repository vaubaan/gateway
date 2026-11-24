// The shell writes a problem in the fragment (`#problem=<sentence>`); it is shown as text.
const match = /^#problem=(.*)$/.exec(window.location.hash);
if (match) {
  document.getElementById('starting').hidden = true;
  document.getElementById('problem').hidden = false;
  document.getElementById('problem-text').textContent = decodeURIComponent(match[1]);
}
