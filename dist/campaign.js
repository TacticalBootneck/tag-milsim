const updates = document.querySelector('#campaign-updates');
function addText(parent, tag, text) {
  const child = document.createElement(tag);
  child.textContent = text;
  parent.append(child);
}
fetch('/api/public-campaign').then(response => {
  if (!response.ok) throw new Error('Public campaign feed unavailable');
  return response.json();
}).then(entries => {
  if (!entries.length) addText(updates,'p','No campaign brief has been released here yet.');
  for (const entry of entries) {
    const card=document.createElement('article');
    card.className='campaign-update cw-report';
    if (entry.id) card.id = 'update-'+entry.id;
    addText(card,'h3',entry.title);
    if (entry.date) addText(card,'p',[entry.campaign,entry.date].filter(Boolean).join(' · '));
    addText(card,'p',entry.summary);
    if (entry.images?.length) {
      const photos = document.createElement('div');
      photos.className = 'cw-photos';
      for (const [index,id] of entry.images.entries()) {
        const image = document.createElement('img');
        image.src = '/campaign-images/'+id;
        image.alt = 'Published Arma Reforger screenshot '+(index+1);
        image.loading = 'lazy';
        photos.append(image);
      }
      card.append(photos);
    }
    if (entry.intel?.length) {
      const list=document.createElement('ul');
      for (const point of entry.intel) addText(list,'li',point);
      card.append(list);
    }
    updates.append(card);
  }
  if (location.hash.startsWith('#update-')) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}).catch(()=>addText(updates,'p','Campaign updates are temporarily unavailable.'));
