import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Expand } from "lucide-react";
import heroImage from "@/assets/hero-restaurant.jpg";
import foodImage from "@/assets/fine-dining-plate.jpg";
import cocktailImage from "@/assets/craft-cocktails.jpg";

const Gallery = () => {
  const [currentCategory, setCurrentCategory] = useState("all");
  
  const categories = [
    { id: "all", label: "All" },
    { id: "interior", label: "Interior" },
    { id: "food", label: "Food" },
    { id: "cocktails", label: "Cocktails" },
    { id: "events", label: "Events" }
  ];

  const galleryItems = [
    {
      id: 1,
      image: heroImage,
      title: "Main Dining Room",
      category: "interior",
      description: "Gold chandeliers and velvet banquettes create an atmosphere of luxury"
    },
    {
      id: 2,
      image: foodImage,
      title: "Signature Plating",
      category: "food", 
      description: "Each dish is crafted as a work of art"
    },
    {
      id: 3,
      image: cocktailImage,
      title: "Craft Cocktails",
      category: "cocktails",
      description: "Artfully crafted drinks at our elegant bar"
    },
    {
      id: 4,
      image: heroImage,
      title: "Vintage Photo Wall",
      category: "interior",
      description: "Celebrating culture and community through photography"
    },
    {
      id: 5,
      image: foodImage,
      title: "Chef's Special",
      category: "food",
      description: "Southern soul meets modern technique"
    },
    {
      id: 6,
      image: cocktailImage,
      title: "Golden Hour",
      category: "cocktails",
      description: "Our signature cocktail program"
    }
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