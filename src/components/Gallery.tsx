import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Expand } from "lucide-react";
import heroImage from "@/assets/hero-restaurant.jpg";



const Gallery = () => {
  const [currentCategory, setCurrentCategory] = useState("all");
  
  const categories = [
    { id: "all", label: "All" }
  ];

  const galleryItems = [
    { id: 1, image: "/lovable-uploads/ab3d54a6-16a6-4d65-97f6-035597e43363.png", title: "Grand Dining Room Aisle", category: "all", description: "Velvet banquettes, gold drapery, and a crystal chandelier." },
    { id: 2, image: "/lovable-uploads/e3818c3c-f025-4cbe-b8ad-bf435168ef1b.png", title: "Dining Room Panorama", category: "all", description: "Expansive view of our elegant dining room and chandelier." },
    { id: 3, image: "/lovable-uploads/f9018a80-bd90-4c1a-a857-e10d3898caa0.png", title: "Intimate Corner Seating", category: "all", description: "Gold tufted seating with refined table settings." },
    { id: 4, image: "/lovable-uploads/721d9e64-7f5b-4031-9732-4f12cd3968e6.png", title: "Chandelier Detail", category: "all", description: "Opulent crystal chandelier over the main floor." },
    { id: 5, image: "/lovable-uploads/b698a030-11b4-4877-89ef-151bd687a332.png", title: "Dining Room Perspective", category: "all", description: "Signature gold and marble accents throughout." },
    { id: 6, image: "/lovable-uploads/8f451f04-db68-4d54-b4d4-75574f6bd736.png", title: "Banquette View", category: "all", description: "Elegant mirrors and gold drapes frame the space." },
    { id: 7, image: "/lovable-uploads/4692a049-cf96-4742-ad15-0538a777ec33.png", title: "Table Setting Close-up", category: "all", description: "Polished glassware and black accents for contrast." },
    { id: 8, image: "/lovable-uploads/7235fdc5-9400-478a-a585-18cce9f51f98.png", title: "Symmetry & Style", category: "all", description: "A refined, symmetrical view of the dining salon." }
  ];

  const filteredItems = currentCategory === "all" 
    ? galleryItems 
    : galleryItems.filter(item => item.category === currentCategory);

  return (
    <section id="gallery" className="py-24 px-6 bg-cream">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-16">
          <h2 className="font-display text-5xl lg:text-6xl font-bold text-jet-black mb-6">
            Experience the{" "}
            <span className="text-gold">Atmosphere</span>
          </h2>
          <p className="text-xl text-jet-black/70 max-w-2xl mx-auto">
            Step inside Proper Cuisine and discover the perfect blend of luxury, comfort, and style.
          </p>
        </div>

        {/* Category Filter */}
        <div className="flex flex-wrap justify-center gap-4 mb-12">
          {categories.map((category) => (
            <Button
              key={category.id}
              variant={currentCategory === category.id ? "gold" : "outline-gold"}
              onClick={() => setCurrentCategory(category.id)}
              className="px-6"
            >
              {category.label}
            </Button>
          ))}
        </div>

        {/* Gallery Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {filteredItems.map((item, index) => (
            <Card 
              key={item.id} 
              className="group overflow-hidden bg-pure-white border-gold/20 hover:shadow-elegant transition-all duration-500"
              style={{ animationDelay: `${index * 100}ms` }}
            >
              <div className="relative aspect-[4/3] overflow-hidden">
                <img 
                  src={item.image} 
                  alt={item.title}
                  className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-jet-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                
                {/* Overlay Content */}
                <div className="absolute inset-0 flex items-end p-6 opacity-0 group-hover:opacity-100 transition-opacity duration-500">
                  <div className="text-pure-white">
                    <h3 className="font-display text-xl font-bold mb-2">{item.title}</h3>
                    <p className="text-sm text-cream/90">{item.description}</p>
                  </div>
                  <Button 
                    variant="ghost" 
                    size="icon"
                    className="absolute top-4 right-4 text-pure-white hover:text-gold hover:bg-pure-white/20"
                  >
                    <Expand className="w-5 h-5" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>

        {/* Featured Highlight */}
        <div className="mt-16 bg-gradient-gold rounded-3xl overflow-hidden">
          <div className="grid lg:grid-cols-2 items-center">
            <div className="p-12 lg:p-16">
              <h3 className="font-display text-4xl font-bold text-jet-black mb-6">
                Every Detail Matters
              </h3>
              <p className="text-jet-black/80 text-lg leading-relaxed mb-8">
                From the warm glow of our gold chandeliers to the classic elegance of our 
                black-and-white checkered floors, every element at Proper Cuisine has been 
                carefully curated to create an unforgettable dining experience.
              </p>
              
              <div className="space-y-4 mb-8">
                <div className="flex items-center space-x-3">
                  <div className="w-2 h-2 bg-jet-black rounded-full"></div>
                  <span className="text-jet-black/80">Gold chandeliers & ambient lighting</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-2 h-2 bg-jet-black rounded-full"></div>
                  <span className="text-jet-black/80">Velvet banquettes & elegant seating</span>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="w-2 h-2 bg-jet-black rounded-full"></div>
                  <span className="text-jet-black/80">Vintage photo wall celebrating culture</span>
                </div>
              </div>
              
              <Button variant="dark-elegant" size="lg">
                Schedule a Visit
              </Button>
            </div>
            
            <div className="relative h-96 lg:h-full">
              <img 
                src={heroImage} 
                alt="Interior Details"
                className="w-full h-full object-cover"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Gallery;