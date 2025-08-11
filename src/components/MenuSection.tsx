import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Download, Clock, Coffee, Utensils, Wine } from "lucide-react";
import foodImage from "@/assets/fine-dining-plate.jpg";
import cocktailImage from "@/assets/craft-cocktails.jpg";

const MenuSection = () => {
  const menuItems = [
    {
      title: "Brunch",
      subtitle: "Decadent bites & champagne-soaked Sundays",
      description: "Weekend indulgence meets Southern soul. Our brunch menu features elevated classics with a modern twist.",
      icon: Coffee,
      time: "Sat-Sun | 10AM-3PM",
      image: foodImage,
      highlights: ["Shrimp & Grits Royale", "Chicken & Waffle Stack", "Proper Benedict"]
    },
    {
      title: "Dinner",
      subtitle: "Elevated classics with chef-driven finesse",
      description: "Our dinner service showcases the finest ingredients transformed through Southern tradition and modern technique.",
      icon: Utensils,
      time: "Wed-Sun | 5PM-11PM",
      image: foodImage,
      highlights: ["Bourbon Glazed Short Rib", "Blackened Red Snapper", "Heritage Pork Chop"]
    },
    {
      title: "Cocktails",
      subtitle: "Artfully crafted, elegantly served",
      description: "Our bar program celebrates classic cocktails with a Southern twist, featuring premium spirits and house-made ingredients.",
      icon: Wine,
      time: "Wed-Sun | 5PM-Late",
      image: cocktailImage,
      highlights: ["Old Fashioned Proper", "Golden Hour Martini", "Baltimore Boulevardier"]
    }
  ];

  return (
    <section id="menus" className="py-24 px-6 bg-jet-black">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-16">
          <h2 className="font-display text-5xl lg:text-6xl font-bold text-pure-white mb-6">
            Choose Your{" "}
            <span className="text-gold">Proper</span> Moment
          </h2>
          <p className="text-xl text-cream/80 max-w-2xl mx-auto">
            Each menu tells a story of tradition, innovation, and the pursuit of culinary excellence.
          </p>
        </div>

        {/* Menu Cards */}
        <div className="grid lg:grid-cols-3 gap-8 mb-16">
          {menuItems.map((menu, index) => (
            <Card key={menu.title} className="bg-cream border-gold/20 overflow-hidden group hover:shadow-gold transition-all duration-500">
              <CardContent className="p-8">
                <div className="flex items-center space-x-2 text-jet-black/60 mb-4">
                  <menu.icon className="w-5 h-5" />
                  <Clock className="w-4 h-4" />
                  <span className="text-sm">{menu.time}</span>
                </div>
                
                <h3 className="font-display text-3xl font-bold text-jet-black mb-2">
                  {menu.title}
                </h3>
                <p className="text-gold font-medium mb-4">{menu.subtitle}</p>
                <p className="text-jet-black/70 mb-6 leading-relaxed">
                  {menu.description}
                </p>
                
                <div className="space-y-3 mb-6">
                  <h4 className="font-semibold text-jet-black">Featured Dishes:</h4>
                  <ul className="space-y-1">
                    {menu.highlights.map((dish) => (
                      <li key={dish} className="text-jet-black/70 text-sm flex items-center">
                        <span className="w-1.5 h-1.5 bg-gold rounded-full mr-3"></span>
                        {dish}
                      </li>
                    ))}
                  </ul>
                </div>
                
                <Button variant="gold" className="w-full">
                  View {menu.title} Menu
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Download Section */}
        <div className="bg-gradient-gold rounded-3xl p-12 text-center">
          <h3 className="font-display text-3xl font-bold text-jet-black mb-4">
            Take Our Menus With You
          </h3>
          <p className="text-jet-black/80 mb-8 max-w-2xl mx-auto">
            Download our complete menu collection to explore all our offerings at your leisure.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button 
              variant="dark-elegant" 
              size="lg" 
              className="flex items-center space-x-2"
              onClick={() => window.open('/lovable-uploads/307c5cb3-4934-4387-9d12-8744feaf9b63.png', '_blank')}
            >
              <Download className="w-5 h-5" />
              <span>View Dinner Menu</span>
            </Button>
            <Button variant="outline" size="lg" className="border-jet-black text-jet-black hover:bg-jet-black hover:text-gold">
              View Wine List
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
};

export default MenuSection;