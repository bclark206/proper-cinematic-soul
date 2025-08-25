import { MapPin, Phone, Mail, Instagram, Facebook, Twitter } from "lucide-react";
import { Link } from "react-router-dom";

const Footer = () => {
  return (
    <footer className="bg-jet-black border-t border-gold/20 py-16 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="grid lg:grid-cols-4 gap-12">
          {/* Brand */}
          <div className="lg:col-span-2">
            <h3 className="font-display text-3xl font-bold text-gold mb-4">
              Proper Cuisine
            </h3>
            <p className="text-cream/80 text-lg mb-6 max-w-md">
              Where soul meets elegance. A modern tribute to timeless hospitality 
              in the heart of Baltimore.
            </p>
            
            <div className="flex space-x-4">
              <a href="https://instagram.com/thepropercuisine" className="text-cream hover:text-gold transition-colors">
                <Instagram className="w-6 h-6" />
              </a>
              <a href="#" className="text-cream hover:text-gold transition-colors">
                <Facebook className="w-6 h-6" />
              </a>
              <a href="#" className="text-cream hover:text-gold transition-colors">
                <Twitter className="w-6 h-6" />
              </a>
            </div>
          </div>

          {/* Contact Info */}
          <div>
            <h4 className="font-display text-xl font-bold text-pure-white mb-6">
              Contact
            </h4>
            <div className="space-y-4 text-cream/80">
              <div className="flex items-start space-x-3">
                <MapPin className="w-5 h-5 mt-0.5 text-gold" />
                <div>
                  <p>206 E Redwood St</p>
                  <p>Baltimore, MD 21202</p>
                </div>
              </div>
              
              <div className="flex items-center space-x-3">
                <Phone className="w-5 h-5 text-gold" />
                <p>(443) 432-2771</p>
              </div>
              
              <div className="flex items-center space-x-3">
                <Mail className="w-5 h-5 text-gold" />
                <p>info@propercuisine.com</p>
              </div>
            </div>
          </div>

          {/* Hours */}
          <div>
            <h4 className="font-display text-xl font-bold text-pure-white mb-6">
              Hours
            </h4>
            <div className="space-y-3 text-cream/80">
              <div>
                <p className="font-medium text-pure-white">Sunday</p>
                <p>11am-11pm</p>
              </div>
              
              <div>
                <p className="font-medium text-pure-white">Monday-Thursday</p>
                <p>12pm-11pm</p>
              </div>
              
              <div>
                <p className="font-medium text-pure-white">Friday-Saturday</p>
                <p>12pm-12am</p>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mt-12 pt-8 border-t border-gold/20 flex flex-col md:flex-row justify-between items-center">
          <p className="text-cream/60 text-sm">
            © 2024 Proper Cuisine. All rights reserved.
          </p>
          
          <div className="flex space-x-6 mt-4 md:mt-0">
            <Link to="/sms-compliance" className="text-cream/60 hover:text-gold text-sm transition-colors">
              SMS Updates
            </Link>
            <Link to="/privacy-policy" className="text-cream/60 hover:text-gold text-sm transition-colors">
              Privacy Policy
            </Link>
            <Link to="/terms-conditions" className="text-cream/60 hover:text-gold text-sm transition-colors">
              Terms & Conditions
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;