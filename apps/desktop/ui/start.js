// The shell writes a problem in the fragment (`#problem=<sentence>`), or the version it is
// installing (`#updating=<version>`); either is shown as text.
const problem = /^#problem=(.*)$/.exec(window.location.hash);
const updating = /^#updating=(.*)$/.exec(window.location.hash);
if (problem) {
  document.getElementById('starting').hidden = true;
  document.getElementById('problem').hidden = false;
  document.getElementById('problem-text').textContent = decodeURIComponent(problem[1]);
} else if (updating) {
  document.getElementById('starting').textContent =
    `Installing Vaubaan ${decodeURIComponent(updating[1])}… The app opens again in a moment.`;
}
