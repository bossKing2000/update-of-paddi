const comidasArgentinas = [
    "Ñoquis",
    "Empanadas",
    "Lasaña",
    "Hamburguesa",
    "buñuelos",
    "Guiso",
    "Asado",
    "Fideos a la boloniesa ñ",
    "Locro"
]

const randomFood = () => {
    const comida = comidasArgentinas[Math.floor(Math.random() * comidasArgentinas.length)];
    console.log(comida);
}



module.exports = { randomFood };