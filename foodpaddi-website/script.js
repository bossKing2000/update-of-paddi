const apiURL = "http://localhost:5000/api/product";
const productList = document.getElementById("product-list");
const pageInfo = document.getElementById("pageInfo");
const prevBtn = document.getElementById("prevPage");
const nextBtn = document.getElementById("nextPage");

let currentPage = 1;
let totalPages = 1;

async function fetchProducts(page = 1) {
  try {
    const response = await fetch(`${apiURL}?page=${page}&limit=20`);
    const result = await response.json();

    if (!result.success) {
      productList.innerHTML = "<p>⚠️ Failed to load products.</p>";
      return;
    }

    productList.innerHTML = "";

    result.data.forEach(product => {
      const firstImage = product.images?.[0] || "https://via.placeholder.com/400x300?text=No+Image";
      const liveStatus = product.isLive ? "live" : "offline";
      const liveText = product.isLive ? "Live" : "Offline";

      // 🔗 Wrap each product card in an <a> tag linking to product.html
      const card = `
        <a href="product.html?id=${product.id}" class="card-link">
          <div class="card">
            <img src="${firstImage}" alt="${product.name}" />
            <div class="card-content">
              <h3>${product.name}</h3>
              <p>${product.description}</p>
              <p>Category: ${product.category}</p>
              <p class="price">₦${product.price.toLocaleString()}</p>
              <p class="${liveStatus}">${liveText}</p>
            </div>
          </div>
        </a>
      `;

      productList.insertAdjacentHTML("beforeend", card);
    });

    currentPage = result.pagination.page;
    totalPages = result.pagination.totalPages;
    pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;

    prevBtn.disabled = currentPage === 1;
    nextBtn.disabled = currentPage === totalPages;
  } catch (error) {
    console.error("Error fetching products:", error);
    productList.innerHTML = "<p>❌ Could not fetch data.</p>";
  }
}

prevBtn.addEventListener("click", () => {
  if (currentPage > 1) fetchProducts(currentPage - 1);
});

nextBtn.addEventListener("click", () => {
  if (currentPage < totalPages) fetchProducts(currentPage + 1);
});

fetchProducts();
