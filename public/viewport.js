// viewport.js — shared touch/narrow detection for all wsh pages
// Load as early as possible (<script src="viewport.js"> before body content)
// Sets html.touch (coarse pointer) and html.narrow (<=640px) classes
(function(){
  var d = document.documentElement;
  var tq = matchMedia('(any-pointer:coarse)');
  if (tq.matches) d.classList.add('touch');
  tq.addEventListener('change', function(e){ d.classList.toggle('touch', e.matches) });
  if (matchMedia('(max-width:640px)').matches) d.classList.add('narrow');
  matchMedia('(max-width:640px)').addEventListener('change', function(e){ d.classList.toggle('narrow', e.matches) });
})();
