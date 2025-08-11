import { Button } from "@/components/ui/button";
const heroImage = "/lovable-uploads/acfb37f3-0fb6-4e2a-a2ec-3630b8545589.png";

const Hero = () => {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      {/* Background Image with Overlay */}
      <div 
        className="absolute inset-0 bg-cover bg-center bg-fixed"
        style={{ backgroundImage: `url(${heroImage})` }}
      >
        <div className="absolute inset-0 bg-gradient-hero"></div>
      </div>
      
      {/* Content */}
      <div className="relative z-10 text-center px-6 max-w-4xl mx-auto">
        <h1 className="font-display text-6xl md:text-8xl lg:text-9xl font-bold text-pure-white mb-6 fade-in-up">
          Where Soul Meets{" "}
          <span className="text-gold hover-gold">Elegance</span>
        </h1>
        
        <p className="text-xl md:text-2xl text-cream/90 mb-12 max-w-3xl mx-auto leading-relaxed fade-in-slow font-light">
          Proper Cuisine is a modern tribute to timeless hospitality — luxe interiors, 
          soulful flavors, and elevated vibes in the heart of Baltimore.
        </p>
        
        <div className="flex flex-col sm:flex-row gap-6 justify-center items-center fade-in-slow">
          <Button variant="hero" size="xl" className="min-w-48">
            Reserve Your Table
          </Button>
          <Button variant="outline-gold" size="xl" className="min-w-48 text-pure-white border-pure-white hover:bg-pure-white hover:text-jet-black">
            View Our Menus
          </Button>
        </div>
      </div>

      {/* Scroll Indicator */}
      <div className="absolute bottom-8 left-1/2 transform -translate-x-1/2 text-pure-white/70 animate-bounce">
        <div className="flex flex-col items-center">
          <span className="text-sm mb-2 font-light">Scroll to explore</span>
          <div className="w-px h-8 bg-gradient-to-b from-pure-white/70 to-transparent"></div>
        </div>
      </div>
    </section>
  );
};

export default Hero;