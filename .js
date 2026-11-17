const enterButton = document.getElementById("enterButton");

enterButton.addEventListener("click", function () {

    // Fade out
    document.body.style.opacity = "0";

    document.body.style.transition = "opacity 0.5s ease";

    // Open your map page
    setTimeout(() => {
        window.location.href = "map.html";
    }, 500);

});