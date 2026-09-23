const year=document.getElementById("year");if(year)year.textContent=new Date().getFullYear();
const observer=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting)e.target.classList.add("visible")}),{threshold:.08});
document.querySelectorAll(".section,.features,.join").forEach(el=>observer.observe(el));