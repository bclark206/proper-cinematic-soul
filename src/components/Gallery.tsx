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
    { id: 8, image: "/lovable-uploads/7235fdc5-9400-478a-a585-18cce9f51f98.png", title: "Symmetry & Style", category: "all", description: "A refined, symmetrical view of the dining salon." },
    { id: 9, image: "/lovable-uploads/11f3986d-83be-4818-9505-c83e10c07e57.png", title: "Grand Aisle Perspective", category: "all", description: "A sweeping aisle framed by gold curtains and seating." },
    { id: 10, image: "/lovable-uploads/852749f7-e5b7-4543-83a1-043fa3f7a9a4.png", title: "Panoramic Dining View", category: "all", description: "A wide-angle of the chandelier and dining layout." },
    { id: 11, image: "/lovable-uploads/4d20cfe0-2db9-4acb-938d-ba2de25ad805.png", title: "Table Setting Focus", category: "all", description: "Elegant place settings with pearl napkin rings." },
    { id: 12, image: "/lovable-uploads/c4c831cb-afcf-4195-9078-68117ab29c7e.png", title: "Chandelier & Lounge", category: "all", description: "Crystal chandelier over gold tufted banquettes." },
    { id: 13, image: "/lovable-uploads/2d018f20-6de6-4b87-8290-63abaca61ae8.png", title: "Salon Seating", category: "all", description: "Mirror-lined walls and intimate seating areas." },
    { id: 14, image: "/lovable-uploads/5a10a0b7-7ec0-4933-a968-4e0c4250750f.png", title: "Dining Row View", category: "all", description: "Rows of linen-covered tables and warm lighting." },
    { id: 15, image: "/lovable-uploads/8ce5fdc1-6c42-4270-accc-a345d87344cc.png", title: "Ceiling Details", category: "all", description: "Architectural ceiling details with ambient lighting." },
    { id: 16, image: "/lovable-uploads/b37c9414-8a52-4e2a-85d8-7f4ed80faddc.png", title: "Curved Banquette", category: "all", description: "Curved seating with dramatic drapery and mirrors." },
    { id: 17, image: "/lovable-uploads/e9458ccc-b712-43de-83a3-8c2a6dd33501.png", title: "Corner Lounge", category: "all", description: "Corner vantage with soft window light and decor." },
    { id: 18, image: "/lovable-uploads/cf525d30-1e37-4624-8c51-8d10cada996e.png", title: "Chandelier Overlook", category: "all", description: "Chandelier glow over an elegant banquette line." },
    { id: 19, image: "/lovable-uploads/20d2b171-869a-41b6-b7e7-a0493f3b69f6.png", title: "Bar Counter & Backbar", category: "all", description: "Gold bar top with illuminated backbar and pendant lights." },
    { id: 20, image: "/lovable-uploads/c927a3f3-cf4c-4f98-9ec2-54753cc9729b.png", title: "Backbar Panorama", category: "all", description: "Extensive spirits selection and warm lighting." },
    { id: 21, image: "/lovable-uploads/478e3d70-9f15-4c50-9999-dbfcbc567bca.png", title: "Vintage Photo Wall", category: "all", description: "Gallery of black-and-white portraits and a piano." },
    { id: 22, image: "/lovable-uploads/8b149fd2-dbd3-4920-b07c-b8375591b3a0.png", title: "Photo Wall & Bar", category: "all", description: "Framed photos with golden accents and cozy seating." },
    { id: 23, image: "/lovable-uploads/bda48432-e070-4578-82dc-ed44d295eaa2.png", title: "Champagne Bowl Detail", category: "all", description: "Champagne on ice with photo wall in the background." },
    { id: 24, image: "/lovable-uploads/73013763-e03e-4d57-b1f6-19b348af65a7.png", title: "Lounge Corner", category: "all", description: "Intimate tables by the vintage photo wall." },
    { id: 25, image: "/lovable-uploads/cbe1b304-8ee9-42e8-9e38-c0dcf6deb0f4.png", title: "Bar & Mirror View", category: "all", description: "Bar perspective with mirror and pendant lights." }
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
                src="/lovable-uploads/8f451f04-db68-4d54-b4d4-75574f6bd736.png" 
                alt="Elegant restaurant interior showcasing attention to detail"
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